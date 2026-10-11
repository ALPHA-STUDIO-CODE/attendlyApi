import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { signTicketToken } from "../src/auth/ticketToken";

const app = createApp();

const HOUR = 1000 * 60 * 60;

async function createUser(
  overrides: { name?: string; role?: "USER" | "ADMIN"; label?: string } = {},
) {
  const role = overrides.role ?? "USER";
  const user = await prisma.user.create({
    data: {
      email: `j-${overrides.label ?? "user"}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: overrides.name ?? "J Test User",
      role,
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role }) };
}

async function createEvent(
  overrides: {
    organizerId?: string;
    startsInHours?: number;
    durationHours?: number;
    maxCapacity?: number;
    status?: "PUBLISHED" | "CANCELLED";
  } = {},
) {
  const organizer = overrides.organizerId
    ? null
    : await createUser({ label: "organizer", name: "J Organizer" });
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + (overrides.startsInHours ?? 24 * 30) * HOUR);
  const event = await prisma.event.create({
    data: {
      organizerId: overrides.organizerId ?? organizer!.user.id,
      title: "J Check-in Event",
      description: "An event used to exercise check-in and check-in stats.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + (overrides.durationHours ?? 3) * HOUR),
      maxCapacity: overrides.maxCapacity ?? 50,
      status: overrides.status ?? "PUBLISHED",
    },
  });
  return { event, organizerToken: organizer?.token, organizerId: event.organizerId };
}

async function seedRegistration(
  eventId: string,
  userId: string,
  status: "REGISTERED" | "WAITLISTED" | "CANCELLED",
  extras: { checkedInAt?: Date; waitlistPosition?: number } = {},
) {
  const id = randomUUID();
  return prisma.registration.create({
    data: {
      id,
      eventId,
      userId,
      status,
      waitlistPosition: status === "WAITLISTED" ? (extras.waitlistPosition ?? 1) : null,
      ticketToken: signTicketToken({ registrationId: id, eventId }),
      ...(extras.checkedInAt ? { checkedInAt: extras.checkedInAt } : {}),
    },
  });
}

function scan(eventId: string, token: string | undefined, ticketToken?: unknown) {
  const req = request(app).post(`/api/events/${eventId}/checkin`);
  const authed = token ? req.set("Authorization", `Bearer ${token}`) : req;
  return authed.send(ticketToken === undefined ? {} : { ticketToken });
}

function stats(eventId: string, token?: string) {
  const req = request(app).get(`/api/events/${eventId}/checkin-stats`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
}

async function seedEventWithAttendee(name = "Ada Lovelace") {
  const { event, organizerToken, organizerId } = await createEvent();
  const attendee = await createUser({ name });
  const registration = await seedRegistration(event.id, attendee.user.id, "REGISTERED");
  return { event, organizerToken: organizerToken!, organizerId, attendee, registration };
}

describe("POST /api/events/:id/checkin", () => {
  describe("a valid ticket", () => {
    it("checks the attendee in and returns their name", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee("Ada Lovelace");

      const response = await scan(event.id, organizerToken, registration.ticketToken);

      expect(response.status).toBe(200);
      expect(response.body.attendee).toEqual({ name: "Ada Lovelace" });
      expect(response.body.registration.id).toBe(registration.id);
      const row = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
      expect(row.checkedInAt).toBeInstanceOf(Date);
      expect(response.body.registration.checkedInAt).toBe(row.checkedInAt!.toISOString());
    });

    it("does not hand the attendee's email to the scanner", async () => {
      const { event, organizerToken, attendee, registration } = await seedEventWithAttendee();

      const response = await scan(event.id, organizerToken, registration.ticketToken);

      expect(JSON.stringify(response.body)).not.toContain(attendee.user.email);
    });

    it("lets an admin scan at any event", async () => {
      const { event, registration } = await seedEventWithAttendee();
      const { token: adminToken } = await createUser({ role: "ADMIN", label: "admin" });

      const response = await scan(event.id, adminToken, registration.ticketToken);

      expect(response.status).toBe(200);
    });

    it("works before the event starts — there is no earliest time", async () => {
      const { event, organizerToken } = await createEvent({ startsInHours: 24 * 14 });
      const attendee = await createUser();
      const registration = await seedRegistration(event.id, attendee.user.id, "REGISTERED");

      const response = await scan(event.id, organizerToken, registration.ticketToken);

      expect(response.status).toBe(200);
    });

    it("still works shortly after the event has ended (inside the 24h grace period)", async () => {
      const { event, organizerToken } = await createEvent({ startsInHours: -10, durationHours: 3 });
      const attendee = await createUser();
      const registration = await seedRegistration(event.id, attendee.user.id, "REGISTERED");

      const response = await scan(event.id, organizerToken, registration.ticketToken);

      expect(response.status).toBe(200);
    });
  });

  describe("scanning the same ticket again", () => {
    it("returns 409 ALREADY_CHECKED_IN with the original time and the attendee's name", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee("Ada Lovelace");
      await scan(event.id, organizerToken, registration.ticketToken);
      const first = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });

      const response = await scan(event.id, organizerToken, registration.ticketToken);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ALREADY_CHECKED_IN");
      expect(response.body.error.details).toEqual({
        checkedInAt: first.checkedInAt!.toISOString(),
        attendee: { name: "Ada Lovelace" },
      });
    });

    it("never overwrites the original check-in time", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee();
      await scan(event.id, organizerToken, registration.ticketToken);
      const first = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });

      await scan(event.id, organizerToken, registration.ticketToken);

      const after = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
      expect(after.checkedInAt!.getTime()).toBe(first.checkedInAt!.getTime());
    });

    it("lets exactly one of two simultaneous scans succeed", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee();

      const responses = await Promise.all([
        scan(event.id, organizerToken, registration.ticketToken),
        scan(event.id, organizerToken, registration.ticketToken),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  describe("tickets that are not accepted — one identical 400 INVALID_TICKET", () => {
    async function expectInvalid(eventId: string, organizerToken: string, ticketToken: string) {
      const response = await scan(eventId, organizerToken, ticketToken);
      expect(response.status).toBe(400);
      expect(response.body.error).toEqual({
        code: "INVALID_TICKET",
        message: "Invalid ticket.",
        details: null,
      });
    }

    it("rejects a tampered token", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee();
      const last = registration.ticketToken.slice(-1);
      const tampered = `${registration.ticketToken.slice(0, -1)}${last === "A" ? "B" : "A"}`;

      await expectInvalid(event.id, organizerToken, tampered);
    });

    it("rejects garbage and an empty token", async () => {
      const { event, organizerToken } = await seedEventWithAttendee();

      await expectInvalid(event.id, organizerToken, "definitely-not-a-ticket");
      await expectInvalid(event.id, organizerToken, "");
    });

    it("rejects a token signed with a different secret", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee();
      const forged = jwt.sign(
        { registrationId: registration.id, eventId: event.id },
        "some-other-secret",
      );

      await expectInvalid(event.id, organizerToken, forged);
    });

    it("rejects a real ticket for a different event, with no hint it was a different event", async () => {
      const { event, organizerToken } = await seedEventWithAttendee();
      const other = await seedEventWithAttendee();

      await expectInvalid(event.id, organizerToken, other.registration.ticketToken);
    });

    it("rejects a ticket whose registration was cancelled", async () => {
      const { event, organizerToken } = await createEvent();
      const attendee = await createUser();
      const registration = await seedRegistration(event.id, attendee.user.id, "CANCELLED");

      await expectInvalid(event.id, organizerToken!, registration.ticketToken);
    });

    it("rejects a ticket held by someone who is only on the waitlist", async () => {
      const { event, organizerToken } = await createEvent();
      const attendee = await createUser();
      const registration = await seedRegistration(event.id, attendee.user.id, "WAITLISTED");

      await expectInvalid(event.id, organizerToken!, registration.ticketToken);
      const row = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
      expect(row.checkedInAt).toBeNull();
    });

    it("rejects a validly signed token that isn't the one issued to this registration", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee();
      const notTheIssuedOne = jwt.sign(
        { registrationId: registration.id, eventId: event.id, reissued: true },
        process.env.JWT_TICKET_SECRET!,
      );

      await expectInvalid(event.id, organizerToken, notTheIssuedOne);
      const row = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
      expect(row.checkedInAt).toBeNull();
    });

    it("gives the very same answer for every kind of bad ticket", async () => {
      const { event, organizerToken, registration } = await seedEventWithAttendee();
      const other = await seedEventWithAttendee();
      const bodies = await Promise.all(
        [
          "garbage",
          jwt.sign({ registrationId: registration.id, eventId: event.id }, "other-secret"),
          other.registration.ticketToken,
        ].map(async (ticket) => (await scan(event.id, organizerToken, ticket)).body),
      );

      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    });

    it("rejects a request with no ticketToken field as a validation error", async () => {
      const { event, organizerToken } = await seedEventWithAttendee();

      const response = await scan(event.id, organizerToken);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("event state", () => {
    it("refuses a cancelled event with 409 EVENT_NOT_OPEN and checks nobody in", async () => {
      const { event, organizerToken } = await createEvent({ status: "CANCELLED" });
      const attendee = await createUser();
      const registration = await seedRegistration(event.id, attendee.user.id, "REGISTERED");

      const response = await scan(event.id, organizerToken, registration.ticketToken);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("EVENT_NOT_OPEN");
      const row = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
      expect(row.checkedInAt).toBeNull();
    });

    it("refuses once the grace period after the event has passed: 409 CHECKIN_CLOSED", async () => {
      const { event, organizerToken } = await createEvent({ startsInHours: -60, durationHours: 3 });
      const attendee = await createUser();
      const registration = await seedRegistration(event.id, attendee.user.id, "REGISTERED");

      const response = await scan(event.id, organizerToken, registration.ticketToken);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CHECKIN_CLOSED");
      const row = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
      expect(row.checkedInAt).toBeNull();
    });
  });

  describe("who may scan", () => {
    it("rejects a regular user who is not the organizer with 403", async () => {
      const { event, registration } = await seedEventWithAttendee();
      const { token } = await createUser();

      const response = await scan(event.id, token, registration.ticketToken);

      expect(response.status).toBe(403);
    });

    it("rejects an attendee scanning their own ticket with 403", async () => {
      const { event, attendee, registration } = await seedEventWithAttendee();

      const response = await scan(event.id, attendee.token, registration.ticketToken);

      expect(response.status).toBe(403);
      const row = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
      expect(row.checkedInAt).toBeNull();
    });

    it("rejects another event's organizer with 403", async () => {
      const { event, registration } = await seedEventWithAttendee();
      const { token } = await createUser({ label: "other-organizer" });

      const response = await scan(event.id, token, registration.ticketToken);

      expect(response.status).toBe(403);
    });

    it("rejects an unauthenticated request with 401", async () => {
      const { event, registration } = await seedEventWithAttendee();

      const response = await scan(event.id, undefined, registration.ticketToken);

      expect(response.status).toBe(401);
    });

    it("returns 404 for an event that does not exist", async () => {
      const { token } = await createUser();

      const response = await scan("00000000-0000-0000-0000-000000000000", token, "anything");

      expect(response.status).toBe(404);
    });
  });
});

describe("GET /api/events/:id/checkin-stats", () => {
  it("counts seated, checked-in and waitlisted attendees against the capacity", async () => {
    const { event, organizerToken } = await createEvent({ maxCapacity: 10 });
    const users = await Promise.all(Array.from({ length: 6 }, () => createUser()));
    const now = new Date();
    await seedRegistration(event.id, users[0].user.id, "REGISTERED", { checkedInAt: now });
    await seedRegistration(event.id, users[1].user.id, "REGISTERED", { checkedInAt: now });
    await seedRegistration(event.id, users[2].user.id, "REGISTERED");
    await seedRegistration(event.id, users[3].user.id, "WAITLISTED", { waitlistPosition: 1 });
    await seedRegistration(event.id, users[4].user.id, "WAITLISTED", { waitlistPosition: 2 });
    // Cancelled after being checked in: not counted anywhere.
    await seedRegistration(event.id, users[5].user.id, "CANCELLED", { checkedInAt: now });

    const response = await stats(event.id, organizerToken);

    expect(response.status).toBe(200);
    expect(response.body.stats).toEqual({
      capacity: 10,
      registered: 3,
      checkedIn: 2,
      notCheckedIn: 1,
      waitlisted: 2,
    });
  });

  it("returns zeros, with the capacity, for an event nobody registered for", async () => {
    const { event, organizerToken } = await createEvent({ maxCapacity: 25 });

    const response = await stats(event.id, organizerToken);

    expect(response.body.stats).toEqual({
      capacity: 25,
      registered: 0,
      checkedIn: 0,
      notCheckedIn: 0,
      waitlisted: 0,
    });
  });

  it("goes up after a real scan", async () => {
    const { event, organizerToken, registration } = await seedEventWithAttendee();
    const before = await stats(event.id, organizerToken);

    await scan(event.id, organizerToken, registration.ticketToken);
    const after = await stats(event.id, organizerToken);

    expect(before.body.stats).toMatchObject({ registered: 1, checkedIn: 0, notCheckedIn: 1 });
    expect(after.body.stats).toMatchObject({ registered: 1, checkedIn: 1, notCheckedIn: 0 });
  });

  it("lets an admin read any event's stats", async () => {
    const { event } = await createEvent();
    const { token: adminToken } = await createUser({ role: "ADMIN", label: "admin" });

    const response = await stats(event.id, adminToken);

    expect(response.status).toBe(200);
  });

  it("rejects a regular user who is not the organizer with 403", async () => {
    const { event } = await createEvent();
    const { token } = await createUser();

    const response = await stats(event.id, token);

    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { event } = await createEvent();

    const response = await stats(event.id);

    expect(response.status).toBe(401);
  });

  it("returns 404 for an event that does not exist", async () => {
    const { token } = await createUser();

    const response = await stats("00000000-0000-0000-0000-000000000000", token);

    expect(response.status).toBe(404);
  });
});
