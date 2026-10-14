import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { signTicketToken } from "../src/auth/ticketToken";

const app = createApp();

const HOUR = 1000 * 60 * 60;

async function createUser(role: "USER" | "ADMIN" = "USER", label = "user") {
  const user = await prisma.user.create({
    data: {
      email: `l3-${label}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: `L3 ${label}`,
      role,
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role }) };
}

async function createEvent(
  overrides: {
    organizerId?: string;
    title?: string;
    status?: "PUBLISHED" | "CANCELLED" | "FLAGGED";
    maxCapacity?: number;
    deletedAt?: Date;
  } = {},
) {
  const organizerId = overrides.organizerId ?? (await createUser("USER", "organizer")).user.id;
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 30 * 24 * HOUR);
  return prisma.event.create({
    data: {
      organizerId,
      title: overrides.title ?? "L3 Test Event",
      description: "An event used to exercise admin moderation.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 3 * HOUR),
      maxCapacity: overrides.maxCapacity ?? 50,
      status: overrides.status ?? "PUBLISHED",
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

async function seedRegistration(
  eventId: string,
  userId: string,
  status: "REGISTERED" | "WAITLISTED",
  waitlistPosition: number | null = null,
) {
  const id = randomUUID();
  return prisma.registration.create({
    data: {
      id,
      eventId,
      userId,
      status,
      waitlistPosition,
      ticketToken: signTicketToken({ registrationId: id, eventId }),
    },
  });
}

function authed(call: request.Test, token: string | null) {
  return token ? call.set("Authorization", `Bearer ${token}`) : call;
}

const removeEvent = (id: string, token: string | null) =>
  authed(request(app).delete(`/api/admin/events/${id}`), token);
const flagEvent = (id: string, token: string | null) =>
  authed(request(app).patch(`/api/admin/events/${id}/flag`), token);
const adminGetEvent = (id: string, token: string | null) =>
  authed(request(app).get(`/api/admin/events/${id}`), token);

describe("DELETE /api/admin/events/:id", () => {
  it("returns 401 without a token", async () => {
    const event = await createEvent();

    expect((await removeEvent(event.id, null)).status).toBe(401);
  });

  it("returns 403 for a regular user — including the event's own organizer — and changes nothing", async () => {
    const organizer = await createUser("USER", "organizer");
    const event = await createEvent({ organizerId: organizer.user.id });
    const other = await createUser();

    expect((await removeEvent(event.id, other.token)).status).toBe(403);
    expect((await removeEvent(event.id, organizer.token)).status).toBe(403);
    expect(
      (await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).deletedAt,
    ).toBeNull();
  });

  it("returns 404 for an event that doesn't exist", async () => {
    const admin = await createUser("ADMIN", "admin");

    const response = await removeEvent("00000000-0000-0000-0000-000000000000", admin.token);

    expect(response.status).toBe(404);
  });

  it("sets deletedAt, and never touches the event's content or status", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent({ title: "Content Must Survive" });

    const response = await removeEvent(event.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.event.deletedAt).toEqual(expect.any(String));
    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.deletedAt).not.toBeNull();
    expect({ ...after, deletedAt: null, updatedAt: event.updatedAt }).toEqual(event);
  });

  it("is idempotent: deleting again returns 200 and keeps the original deletion time", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent();
    const first = await removeEvent(event.id, admin.token);

    const second = await removeEvent(event.id, admin.token);

    expect(second.status).toBe(200);
    expect(second.body.event.deletedAt).toBe(first.body.event.deletedAt);
  });

  it("removes the event from the public listing, even when searched for by title", async () => {
    const admin = await createUser("ADMIN", "admin");
    const title = `L3 Listed ${randomUUID()}`;
    const event = await createEvent({ title });
    const before = await request(app).get(`/api/events?search=${encodeURIComponent(title)}`);
    expect(before.body.events.map((row: { id: string }) => row.id)).toContain(event.id);

    await removeEvent(event.id, admin.token);

    const after = await request(app).get(`/api/events?search=${encodeURIComponent(title)}`);
    expect(after.status).toBe(200);
    expect(after.body.events.map((row: { id: string }) => row.id)).not.toContain(event.id);
    expect(after.body.pagination.total).toBe(0);
  });

  it("makes the public event detail a 404", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent();
    await removeEvent(event.id, admin.token);

    const response = await request(app).get(`/api/events/${event.id}`);

    expect(response.status).toBe(404);
  });

  it("closes the event to new registrations (404), leaving existing ones in place", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent();
    const attendee = await createUser("USER", "attendee");
    const registration = await seedRegistration(event.id, attendee.user.id, "REGISTERED");
    await removeEvent(event.id, admin.token);
    const newcomer = await createUser("USER", "newcomer");

    const response = await request(app)
      .post(`/api/events/${event.id}/register`)
      .set("Authorization", `Bearer ${newcomer.token}`);

    expect(response.status).toBe(404);
    expect(await prisma.registration.count({ where: { eventId: event.id } })).toBe(1);
    expect(
      (await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } })).status,
    ).toBe("REGISTERED");
  });

  it("lets an attendee cancel on a removed event, but promotes nobody from the waitlist", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent({ maxCapacity: 1 });
    const seated = await createUser("USER", "seated");
    const waiting = await createUser("USER", "waiting");
    await seedRegistration(event.id, seated.user.id, "REGISTERED");
    const waitlisted = await seedRegistration(event.id, waiting.user.id, "WAITLISTED", 1);
    await removeEvent(event.id, admin.token);

    const response = await request(app)
      .delete(`/api/events/${event.id}/register`)
      .set("Authorization", `Bearer ${seated.token}`);

    expect(response.status).toBe(200);
    expect(response.body.registration.status).toBe("CANCELLED");
    const stillWaiting = await prisma.registration.findUniqueOrThrow({
      where: { id: waitlisted.id },
    });
    expect(stillWaiting.status).toBe("WAITLISTED");
  });

  it("hides the registration from the attendee's own list", async () => {
    const admin = await createUser("ADMIN", "admin");
    const attendee = await createUser("USER", "attendee");
    const removed = await createEvent();
    const kept = await createEvent();
    await seedRegistration(removed.id, attendee.user.id, "REGISTERED");
    await seedRegistration(kept.id, attendee.user.id, "REGISTERED");
    await removeEvent(removed.id, admin.token);

    const response = await request(app)
      .get("/api/me/registrations")
      .set("Authorization", `Bearer ${attendee.token}`);

    expect(response.status).toBe(200);
    const eventIds = [...response.body.upcoming, ...response.body.past].map(
      (row: { eventId: string }) => row.eventId,
    );
    expect(eventIds).toEqual([kept.id]);
  });

  it("makes every organizer route a 404, so a removed event can't be edited, cancelled or scanned", async () => {
    const organizer = await createUser("USER", "organizer");
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent({ organizerId: organizer.user.id });
    await removeEvent(event.id, admin.token);
    const auth = { Authorization: `Bearer ${organizer.token}` };
    const adminAuth = { Authorization: `Bearer ${admin.token}` };

    const attempts = [
      request(app).patch(`/api/events/${event.id}`).set(auth).send({ title: "Nope" }),
      request(app).delete(`/api/events/${event.id}`).set(auth),
      request(app).post(`/api/events/${event.id}/banner`).set(auth),
      request(app).get(`/api/events/${event.id}/registrations`).set(auth),
      request(app).get(`/api/events/${event.id}/registrations/export`).set(auth),
      request(app).get(`/api/events/${event.id}/checkin-stats`).set(auth),
      request(app).post(`/api/events/${event.id}/checkin`).set(auth).send({ ticketToken: "x" }),
      request(app).get(`/api/events/${event.id}/registrations`).set(adminAuth),
    ];
    const responses = await Promise.all(attempts);

    expect(responses.map((response) => response.status)).toEqual(responses.map(() => 404));
    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.title).toBe(event.title);
    expect(after.status).toBe("PUBLISHED");
  });
});

describe("GET /api/admin/events/:id", () => {
  it("returns 401 without a token and 403 for a non-admin", async () => {
    const event = await createEvent();
    const { token } = await createUser();

    expect((await adminGetEvent(event.id, null)).status).toBe(401);
    expect((await adminGetEvent(event.id, token)).status).toBe(403);
  });

  it("returns 404 for an event that doesn't exist", async () => {
    const admin = await createUser("ADMIN", "admin");

    expect((await adminGetEvent("00000000-0000-0000-0000-000000000000", admin.token)).status).toBe(
      404,
    );
  });

  it("still returns a removed event for audit, with deletedAt, the organizer's email and a report count", async () => {
    const admin = await createUser("ADMIN", "admin");
    const organizer = await createUser("USER", "organizer");
    const reporter = await createUser("USER", "reporter");
    const event = await createEvent({ organizerId: organizer.user.id, deletedAt: new Date() });
    await prisma.report.create({
      data: { eventId: event.id, reporterId: reporter.user.id, reason: "Bad." },
    });

    const response = await adminGetEvent(event.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.event).toMatchObject({
      id: event.id,
      title: event.title,
      deletedAt: expect.any(String),
      organizer: { id: organizer.user.id, email: organizer.user.email },
      _count: { reports: 1 },
    });
  });
});

describe("PATCH /api/admin/events/:id/flag", () => {
  it("returns 401 without a token", async () => {
    const event = await createEvent();

    expect((await flagEvent(event.id, null)).status).toBe(401);
  });

  it("returns 403 for a regular user — including the organizer — and changes nothing", async () => {
    const organizer = await createUser("USER", "organizer");
    const event = await createEvent({ organizerId: organizer.user.id });

    expect((await flagEvent(event.id, organizer.token)).status).toBe(403);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      "PUBLISHED",
    );
  });

  it("returns 404 for an event that doesn't exist or was removed", async () => {
    const admin = await createUser("ADMIN", "admin");
    const removed = await createEvent({ deletedAt: new Date() });

    expect((await flagEvent("00000000-0000-0000-0000-000000000000", admin.token)).status).toBe(404);
    expect((await flagEvent(removed.id, admin.token)).status).toBe(404);
  });

  it("sets the status to FLAGGED and never touches the event's content", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent({ title: "Flag Must Not Edit" });

    const response = await flagEvent(event.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.event.status).toBe("FLAGGED");
    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect({ ...after, status: "PUBLISHED", updatedAt: event.updatedAt }).toEqual(event);
  });

  it("keeps a flagged event visible, marked FLAGGED, in the listing and detail", async () => {
    const admin = await createUser("ADMIN", "admin");
    const title = `L3 Flagged ${randomUUID()}`;
    const event = await createEvent({ title });
    await flagEvent(event.id, admin.token);

    const list = await request(app).get(`/api/events?search=${encodeURIComponent(title)}`);
    const detail = await request(app).get(`/api/events/${event.id}`);

    expect(list.body.events).toHaveLength(1);
    expect(list.body.events[0].status).toBe("FLAGGED");
    expect(detail.status).toBe(200);
    expect(detail.body.event.status).toBe("FLAGGED");
  });

  it("closes the event to new registrations (409 EVENT_NOT_OPEN)", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent();
    await flagEvent(event.id, admin.token);
    const attendee = await createUser();

    const response = await request(app)
      .post(`/api/events/${event.id}/register`)
      .set("Authorization", `Bearer ${attendee.token}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EVENT_NOT_OPEN");
  });

  it("is idempotent for an already-flagged event", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent({ status: "FLAGGED" });

    const response = await flagEvent(event.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.event.status).toBe("FLAGGED");
  });

  it("refuses to flag a cancelled event (409 EVENT_NOT_FLAGGABLE) and leaves it cancelled", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent({ status: "CANCELLED" });

    const response = await flagEvent(event.id, admin.token);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EVENT_NOT_FLAGGABLE");
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      "CANCELLED",
    );
  });

  it("can be removed afterwards: a flagged event can still be soft-deleted", async () => {
    const admin = await createUser("ADMIN", "admin");
    const event = await createEvent();
    await flagEvent(event.id, admin.token);

    const response = await removeEvent(event.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.event).toMatchObject({ status: "FLAGGED", deletedAt: expect.any(String) });
  });
});
