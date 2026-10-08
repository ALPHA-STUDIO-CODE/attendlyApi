import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";

const app = createApp();

async function createUser(i: number) {
  const user = await prisma.user.create({
    data: {
      email: `h2b-user-${Date.now()}-${i}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: `H2b Test User ${i}`,
    },
  });
  return signAccessToken({ sub: user.id, role: "USER" });
}

async function createEvent(maxCapacity: number) {
  const organizer = await prisma.user.create({
    data: {
      email: `h2b-organizer-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "H2b Organizer",
    },
  });
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "H2b Concurrency Test Event",
      description: "An event used to fire N simultaneous registration requests at.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity,
    },
  });
}

describe("POST /api/events/:id/register — concurrency safety", () => {
  it("seats exactly `capacity` REGISTERED and waitlists the rest, with sequential positions, under N simultaneous requests", async () => {
    const CAPACITY = 5;
    const N = 20;
    const event = await createEvent(CAPACITY);
    const tokens = await Promise.all(Array.from({ length: N }, (_, i) => createUser(i)));

    // Fired together, not awaited one at a time — this is the whole point
    // of the test.
    const responses = await Promise.all(
      tokens.map((token) =>
        request(app)
          .post(`/api/events/${event.id}/register`)
          .set("Authorization", `Bearer ${token}`),
      ),
    );

    // No request should surface a DB constraint violation as a 500 — every
    // response is either a clean 201 registered or 201 waitlisted.
    for (const response of responses) {
      expect(response.status).toBe(201);
    }

    const registered = responses.filter((r) => r.body.registration.status === "REGISTERED");
    const waitlisted = responses.filter((r) => r.body.registration.status === "WAITLISTED");

    expect(registered).toHaveLength(CAPACITY);
    expect(waitlisted).toHaveLength(N - CAPACITY);

    const positions = waitlisted
      .map((r) => r.body.registration.waitlistPosition)
      .sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: N - CAPACITY }, (_, i) => i + 1));

    // Cross-check against the database directly, not just the HTTP
    // responses — this is what actually rules out overselling.
    const dbRegisteredCount = await prisma.registration.count({
      where: { eventId: event.id, status: "REGISTERED" },
    });
    const dbTotalCount = await prisma.registration.count({ where: { eventId: event.id } });
    expect(dbRegisteredCount).toBe(CAPACITY);
    expect(dbTotalCount).toBe(N);
  }, 60_000);

  it("never oversells even when the request count is a large multiple of capacity", async () => {
    const CAPACITY = 2;
    const N = 30;
    const event = await createEvent(CAPACITY);
    const tokens = await Promise.all(Array.from({ length: N }, (_, i) => createUser(i)));

    await Promise.all(
      tokens.map((token) =>
        request(app)
          .post(`/api/events/${event.id}/register`)
          .set("Authorization", `Bearer ${token}`),
      ),
    );

    const dbRegisteredCount = await prisma.registration.count({
      where: { eventId: event.id, status: "REGISTERED" },
    });
    expect(dbRegisteredCount).toBe(CAPACITY);
  }, 60_000);
});
