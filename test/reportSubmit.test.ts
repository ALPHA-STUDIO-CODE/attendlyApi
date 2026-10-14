import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";

const app = createApp();

async function createUser(role: "USER" | "ADMIN" = "USER", label = "user") {
  const user = await prisma.user.create({
    data: {
      email: `l1-${label}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: `L1 ${label}`,
      role,
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role }) };
}

async function createEvent(
  overrides: { status?: "PUBLISHED" | "CANCELLED" | "FLAGGED"; deletedAt?: Date } = {},
) {
  const { user: organizer } = await createUser("USER", "organizer");
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "L1 Test Event",
      description: "An event used to exercise POST /api/events/:id/report.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: 50,
      status: overrides.status ?? "PUBLISHED",
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

function report(eventId: string, token: string | null, body: unknown) {
  const call = request(app).post(`/api/events/${eventId}/report`);
  return (token ? call.set("Authorization", `Bearer ${token}`) : call).send(body as object);
}

describe("POST /api/events/:id/report", () => {
  it("files an OPEN report and returns it (201)", async () => {
    const event = await createEvent();
    const { user, token } = await createUser();

    const response = await report(event.id, token, { reason: "This looks like a scam." });

    expect(response.status).toBe(201);
    expect(response.body.report).toMatchObject({
      eventId: event.id,
      reason: "This looks like a scam.",
      status: "OPEN",
    });
    const stored = await prisma.report.findUniqueOrThrow({
      where: { id: response.body.report.id },
    });
    expect(stored).toMatchObject({
      eventId: event.id,
      reporterId: user.id,
      reason: "This looks like a scam.",
      status: "OPEN",
    });
  });

  it("does not echo the reporter's identity back", async () => {
    const event = await createEvent();
    const { token } = await createUser();

    const response = await report(event.id, token, { reason: "Spam." });

    expect(response.body.report.reporterId).toBeUndefined();
    expect(response.body.report.reporter).toBeUndefined();
  });

  it("trims whitespace around the reason", async () => {
    const event = await createEvent();
    const { token } = await createUser();

    const response = await report(event.id, token, { reason: "   Offensive banner  " });

    expect(response.status).toBe(201);
    expect(response.body.report.reason).toBe("Offensive banner");
  });

  it("lets an organizer report someone else's event", async () => {
    const event = await createEvent();
    const { token } = await createUser("USER", "other-organizer");

    expect((await report(event.id, token, { reason: "Duplicate listing." })).status).toBe(201);
  });

  it.each(["CANCELLED", "FLAGGED"] as const)("accepts a report on a %s event", async (status) => {
    const event = await createEvent({ status });
    const { token } = await createUser();

    expect((await report(event.id, token, { reason: "Still wrong." })).status).toBe(201);
  });

  it("returns 401 without a token", async () => {
    const event = await createEvent();

    const response = await report(event.id, null, { reason: "Spam." });

    expect(response.status).toBe(401);
  });

  it("returns 403 for an admin (spec §3: admins act through flag/delete, not reports)", async () => {
    const event = await createEvent();
    const { token } = await createUser("ADMIN", "admin");

    const response = await report(event.id, token, { reason: "Spam." });

    expect(response.status).toBe(403);
    expect(await prisma.report.count({ where: { eventId: event.id } })).toBe(0);
  });

  it.each([
    ["a missing reason", {}],
    ["an empty reason", { reason: "" }],
    ["a whitespace-only reason", { reason: "    " }],
    ["a non-string reason", { reason: 42 }],
    ["a reason over 1000 characters", { reason: "x".repeat(1001) }],
  ])("returns 400 with a field error for %s", async (_label, body) => {
    const event = await createEvent();
    const { token } = await createUser();

    const response = await report(event.id, token, body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details.fields.reason).toEqual(expect.any(String));
    expect(await prisma.report.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("returns 404 for an event that doesn't exist", async () => {
    const { token } = await createUser();

    const response = await report("00000000-0000-0000-0000-000000000000", token, {
      reason: "Spam.",
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for an event an admin removed", async () => {
    const event = await createEvent({ deletedAt: new Date() });
    const { token } = await createUser();

    const response = await report(event.id, token, { reason: "Spam." });

    expect(response.status).toBe(404);
    expect(await prisma.report.count({ where: { eventId: event.id } })).toBe(0);
  });

  describe("repeat reports", () => {
    it("refuses a second report from the same user while the first is still open (409)", async () => {
      const event = await createEvent();
      const { token } = await createUser();
      await report(event.id, token, { reason: "First." });

      const response = await report(event.id, token, { reason: "Second." });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ALREADY_REPORTED");
      expect(await prisma.report.count({ where: { eventId: event.id } })).toBe(1);
    });

    it("lets a different user report the same event", async () => {
      const event = await createEvent();
      const first = await createUser();
      const second = await createUser();
      await report(event.id, first.token, { reason: "First." });

      const response = await report(event.id, second.token, { reason: "Also bad." });

      expect(response.status).toBe(201);
      expect(await prisma.report.count({ where: { eventId: event.id } })).toBe(2);
    });

    it("lets the same user report the same event again once the first report was reviewed", async () => {
      const event = await createEvent();
      const { token } = await createUser();
      const first = await report(event.id, token, { reason: "First." });
      await prisma.report.update({
        where: { id: first.body.report.id },
        data: { status: "REVIEWED" },
      });

      const response = await report(event.id, token, { reason: "It's back." });

      expect(response.status).toBe(201);
    });

    it("lets the same user report different events", async () => {
      const eventA = await createEvent();
      const eventB = await createEvent();
      const { token } = await createUser();
      await report(eventA.id, token, { reason: "A." });

      expect((await report(eventB.id, token, { reason: "B." })).status).toBe(201);
    });
  });
});
