import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { verifyTicketToken } from "../src/auth/ticketToken";

const app = createApp();

async function createUser() {
  const user = await prisma.user.create({
    data: {
      email: `h2-user-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "H2 Test User",
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role: "USER" }) };
}

async function createEvent(
  overrides: { maxCapacity?: number; status?: "PUBLISHED" | "CANCELLED" | "FLAGGED" } = {},
) {
  const { user: organizer } = await createUser();
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "H2 Test Event",
      description: "An event used to exercise POST /api/events/:id/register.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: overrides.maxCapacity ?? 50,
      status: overrides.status ?? "PUBLISHED",
    },
  });
}

function register(eventId: string, token: string) {
  return request(app)
    .post(`/api/events/${eventId}/register`)
    .set("Authorization", `Bearer ${token}`);
}

describe("POST /api/events/:id/register", () => {
  describe("happy path", () => {
    it("registers into an open-capacity event with status REGISTERED", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const { token } = await createUser();

      const response = await register(event.id, token);

      expect(response.status).toBe(201);
      expect(response.body.registration.status).toBe("REGISTERED");
      expect(response.body.registration.waitlistPosition).toBeNull();
      expect(response.body.registration.eventId).toBe(event.id);
      expect(response.body.registration.ticketToken).toEqual(expect.any(String));
    });

    it("waitlists once the event is at capacity, with position 1", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const { token: firstToken } = await createUser();
      const { token: secondToken } = await createUser();

      await register(event.id, firstToken);
      const response = await register(event.id, secondToken);

      expect(response.status).toBe(201);
      expect(response.body.registration.status).toBe("WAITLISTED");
      expect(response.body.registration.waitlistPosition).toBe(1);
    });

    it("assigns sequential waitlist positions to further entrants", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const { token: t1 } = await createUser();
      const { token: t2 } = await createUser();
      const { token: t3 } = await createUser();

      await register(event.id, t1);
      const r2 = await register(event.id, t2);
      const r3 = await register(event.id, t3);

      expect(r2.body.registration.waitlistPosition).toBe(1);
      expect(r3.body.registration.waitlistPosition).toBe(2);
    });

    it("generates a ticketToken that verifies to this registration and event (spec §7.4)", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const { token } = await createUser();

      const response = await register(event.id, token);

      const decoded = verifyTicketToken(response.body.registration.ticketToken);
      expect(decoded.eventId).toBe(event.id);
      expect(decoded.registrationId).toBe(response.body.registration.id);
    });

    it("flips Event.isLocked to true on the first successful registration", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      expect(event.isLocked).toBe(false);
      const { token } = await createUser();

      await register(event.id, token);

      const updated = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(updated.isLocked).toBe(true);
    });

    it("does not rewrite the event (and bump updatedAt) once already locked", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const { token: t1 } = await createUser();
      const { token: t2 } = await createUser();

      await register(event.id, t1);
      const afterFirst = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(afterFirst.isLocked).toBe(true);

      await register(event.id, t2);
      const afterSecond = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    });
  });

  describe("duplicate registration (spec §3.4 / §8.5)", () => {
    it("rejects a second registration attempt by the same REGISTERED user with 409 ALREADY_REGISTERED", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const { token } = await createUser();
      await register(event.id, token);

      const response = await register(event.id, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ALREADY_REGISTERED");
    });

    it("rejects a second registration attempt by an already-WAITLISTED user", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const { token: seated } = await createUser();
      const { token: waitlisted } = await createUser();
      await register(event.id, seated);
      await register(event.id, waitlisted);

      const response = await register(event.id, waitlisted);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ALREADY_REGISTERED");
    });

    it("does not create a second row in the database for a duplicate attempt", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const { token } = await createUser();
      await register(event.id, token);
      await register(event.id, token);

      const count = await prisma.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(1);
    });
  });

  describe("re-registering after cancelling (flagged assumption)", () => {
    it("lets a user with a CANCELLED registration for this event register again", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const { user, token } = await createUser();
      const first = await register(event.id, token);
      await prisma.registration.update({
        where: { id: first.body.registration.id },
        data: { status: "CANCELLED" },
      });

      const response = await register(event.id, token);

      expect(response.status).toBe(201);
      expect(response.body.registration.status).toBe("REGISTERED");
      expect(response.body.registration.id).toBe(first.body.registration.id);

      const count = await prisma.registration.count({
        where: { eventId: event.id, userId: user.id },
      });
      expect(count).toBe(1); // reused the same row, not a second one
    });

    it("clears any prior checkedInAt on re-registration, and still returns a valid ticketToken", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const { token } = await createUser();
      const first = await register(event.id, token);
      await prisma.registration.update({
        where: { id: first.body.registration.id },
        data: { status: "CANCELLED", checkedInAt: new Date() },
      });

      const response = await register(event.id, token);

      expect(response.body.registration.checkedInAt).toBeNull();
      const decoded = verifyTicketToken(response.body.registration.ticketToken);
      expect(decoded.registrationId).toBe(first.body.registration.id);
      expect(decoded.eventId).toBe(event.id);
    });
  });

  describe("event not open for registration (flagged assumption)", () => {
    it("rejects registering for a CANCELLED event with 409 EVENT_NOT_OPEN", async () => {
      const event = await createEvent({ status: "CANCELLED" });
      const { token } = await createUser();

      const response = await register(event.id, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("EVENT_NOT_OPEN");
    });
  });

  describe("authorization and existence", () => {
    it("returns 401 for an unauthenticated request", async () => {
      const event = await createEvent();
      const response = await request(app).post(`/api/events/${event.id}/register`);
      expect(response.status).toBe(401);
    });

    it("returns 404 for a nonexistent event", async () => {
      const { token } = await createUser();
      const response = await register("00000000-0000-0000-0000-000000000000", token);
      expect(response.status).toBe(404);
    });

    it("allows the event's own organizer to register for it", async () => {
      const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
      const { user: organizer, token } = await createUser();
      const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      const event = await prisma.event.create({
        data: {
          organizerId: organizer.id,
          title: "Organizer's own event",
          description: "Checks organizers aren't blocked from registering for their own event.",
          categoryId: category.id,
          venueName: "Test Hall",
          address: "123 Test St",
          city: "Testville",
          timezone: "America/New_York",
          date: start,
          startTime: start,
          endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
          maxCapacity: 10,
        },
      });

      const response = await register(event.id, token);

      expect(response.status).toBe(201);
    });
  });
});
