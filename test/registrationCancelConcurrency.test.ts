import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { signTicketToken } from "../src/auth/ticketToken";

const app = createApp();

// These tests fire many requests at a (possibly remote, pooled) database and
// each one queues behind the Event row lock, so they need far more than the
// 15s integration default. Seeding goes straight through Prisma, not HTTP,
// so setup cost stays out of the picture.
const TEST_TIMEOUT_MS = 60_000;

async function createUsers(count: number, label: string) {
  const users = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      prisma.user.create({
        data: {
          email: `h3b-${label}-${i}-${Date.now()}-${Math.random()}@example.com`,
          passwordHash: "hashed-password",
          name: `H3b ${label} ${i}`,
        },
      }),
    ),
  );
  return users.map((user) => ({
    userId: user.id,
    token: signAccessToken({ sub: user.id, role: "USER" }),
  }));
}

/**
 * Builds an event that is already full, with `seated` REGISTERED attendees and
 * `waitlisted` WAITLISTED ones (positions 1..n), in a known order.
 */
async function seedEvent(seated: number, waitlisted: number) {
  const [organizer] = await createUsers(1, "organizer");
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const event = await prisma.event.create({
    data: {
      organizerId: organizer.userId,
      title: "H3b Concurrency Test Event",
      description: "An event used to fire simultaneous cancellations at.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: seated,
      isLocked: true,
    },
  });

  const attendees = await createUsers(seated + waitlisted, "attendee");
  await prisma.registration.createMany({
    data: attendees.map((attendee, i) => {
      const id = randomUUID();
      const isSeated = i < seated;
      return {
        id,
        eventId: event.id,
        userId: attendee.userId,
        status: isSeated ? ("REGISTERED" as const) : ("WAITLISTED" as const),
        waitlistPosition: isSeated ? null : i - seated + 1,
        ticketToken: signTicketToken({ registrationId: id, eventId: event.id }),
      };
    }),
  });

  return {
    event,
    seated: attendees.slice(0, seated),
    waitlisted: attendees.slice(seated),
  };
}

function cancel(eventId: string, token: string) {
  return request(app)
    .delete(`/api/events/${eventId}/register`)
    .set("Authorization", `Bearer ${token}`);
}

function loadRegistrations(eventId: string) {
  return prisma.registration
    .findMany({ where: { eventId } })
    .then((rows) => new Map(rows.map((r) => [r.userId, r])));
}

describe("DELETE /api/events/:id/register — concurrency safety", () => {
  it(
    "promotes two different waitlisted users when two seated users cancel at once",
    async () => {
      const { event, seated, waitlisted } = await seedEvent(2, 2);

      const responses = await Promise.all(seated.map((u) => cancel(event.id, u.token)));

      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      const byUser = await loadRegistrations(event.id);
      for (const user of seated) {
        expect(byUser.get(user.userId)?.status).toBe("CANCELLED");
      }

      // Both seats were filled by different people: nobody promoted twice,
      // nobody skipped.
      for (const waiter of waitlisted) {
        expect(byUser.get(waiter.userId)?.status).toBe("REGISTERED");
        expect(byUser.get(waiter.userId)?.waitlistPosition).toBeNull();
      }

      const registeredCount = await prisma.registration.count({
        where: { eventId: event.id, status: "REGISTERED" },
      });
      expect(registeredCount).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "promotes exactly one waitlisted user per freed seat under many simultaneous cancellations",
    async () => {
      const CAPACITY = 5;
      const WAITLISTED = 8;
      const { event, seated, waitlisted } = await seedEvent(CAPACITY, WAITLISTED);

      const responses = await Promise.all(seated.map((u) => cancel(event.id, u.token)));

      // No deadlocks / constraint errors surfacing as 500s.
      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      const byUser = await loadRegistrations(event.id);

      // The first CAPACITY waitlisted users (positions 1..5) are promoted...
      for (const waiter of waitlisted.slice(0, CAPACITY)) {
        expect(byUser.get(waiter.userId)?.status).toBe("REGISTERED");
        expect(byUser.get(waiter.userId)?.waitlistPosition).toBeNull();
      }

      // ...and the rest keep their order, renumbered 1..n with no gaps.
      const stillWaiting = waitlisted.slice(CAPACITY);
      expect(stillWaiting.map((w) => byUser.get(w.userId)?.waitlistPosition)).toEqual(
        Array.from({ length: WAITLISTED - CAPACITY }, (_, i) => i + 1),
      );
      for (const waiter of stillWaiting) {
        expect(byUser.get(waiter.userId)?.status).toBe("WAITLISTED");
      }

      const registeredCount = await prisma.registration.count({
        where: { eventId: event.id, status: "REGISTERED" },
      });
      expect(registeredCount).toBe(CAPACITY);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stays consistent when a seated user and a waitlisted user cancel at the same time",
    async () => {
      const { event, seated, waitlisted } = await seedEvent(1, 3);
      const [w1, w2, w3] = waitlisted;

      const responses = await Promise.all([
        cancel(event.id, seated[0].token),
        cancel(event.id, w2.token),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      const byUser = await loadRegistrations(event.id);

      // w1 (lowest position) takes the freed seat; w3 is the only one still waiting.
      expect(byUser.get(w1.userId)?.status).toBe("REGISTERED");
      expect(byUser.get(w2.userId)?.status).toBe("CANCELLED");
      expect(byUser.get(w3.userId)?.status).toBe("WAITLISTED");
      expect(byUser.get(w3.userId)?.waitlistPosition).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
