import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { signTicketToken, verifyTicketToken } from "../src/auth/ticketToken";

const app = createApp();

const HOUR = 1000 * 60 * 60;

async function createUser(
  overrides: { name?: string; role?: "USER" | "ADMIN"; label?: string } = {},
) {
  const role = overrides.role ?? "USER";
  const user = await prisma.user.create({
    data: {
      email: `h4-${overrides.label ?? "user"}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: overrides.name ?? "H4 Test User",
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
    status?: "PUBLISHED" | "CANCELLED";
    title?: string;
  } = {},
) {
  const organizerId = overrides.organizerId ?? (await createUser({ label: "organizer" })).user.id;
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + (overrides.startsInHours ?? 24 * 30) * HOUR);
  return prisma.event.create({
    data: {
      organizerId,
      title: overrides.title ?? "H4 Test Event",
      description: "An event used to exercise the registration listing endpoints.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + (overrides.durationHours ?? 3) * HOUR),
      maxCapacity: 50,
      status: overrides.status ?? "PUBLISHED",
    },
  });
}

/** Seeds a registration row directly (fast, and lets tests control order/positions). */
async function seedRegistration(
  eventId: string,
  userId: string,
  status: "REGISTERED" | "WAITLISTED" | "CANCELLED",
  extras: { waitlistPosition?: number; createdAt?: Date } = {},
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
      ...(extras.createdAt ? { createdAt: extras.createdAt } : {}),
    },
  });
}

function listEventRegistrations(eventId: string, token?: string, query = "") {
  const req = request(app).get(`/api/events/${eventId}/registrations${query}`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
}

function listMyRegistrations(token?: string) {
  const req = request(app).get("/api/me/registrations");
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
}

describe("GET /api/events/:id/registrations", () => {
  it("shows the organizer the full attendee list: seated first, then the waitlist in queue order", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const [seatedLate, seatedEarly, waitSecond, waitFirst] = await Promise.all(
      ["Seated Late", "Seated Early", "Wait Second", "Wait First"].map((name) =>
        createUser({ name }),
      ),
    );
    const t0 = Date.now() - 10 * 60 * 1000;
    await seedRegistration(event.id, seatedLate.user.id, "REGISTERED", {
      createdAt: new Date(t0 + 1000),
    });
    await seedRegistration(event.id, seatedEarly.user.id, "REGISTERED", {
      createdAt: new Date(t0),
    });
    await seedRegistration(event.id, waitSecond.user.id, "WAITLISTED", { waitlistPosition: 2 });
    await seedRegistration(event.id, waitFirst.user.id, "WAITLISTED", { waitlistPosition: 1 });

    const response = await listEventRegistrations(event.id, token);

    expect(response.status).toBe(200);
    const rows = response.body.registrations;
    expect(rows.map((r: { user: { name: string } }) => r.user.name)).toEqual([
      "Seated Early",
      "Seated Late",
      "Wait First",
      "Wait Second",
    ]);
    expect(rows.map((r: { status: string }) => r.status)).toEqual([
      "REGISTERED",
      "REGISTERED",
      "WAITLISTED",
      "WAITLISTED",
    ]);
    expect(rows[2].waitlistPosition).toBe(1);
    expect(rows[3].waitlistPosition).toBe(2);
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
  });

  it("includes each attendee's id, name and email, and check-in state", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const attendee = await createUser({ name: "Ada Attendee" });
    await seedRegistration(event.id, attendee.user.id, "REGISTERED");

    const response = await listEventRegistrations(event.id, token);

    const [row] = response.body.registrations;
    expect(row.user).toEqual({
      id: attendee.user.id,
      name: "Ada Attendee",
      email: attendee.user.email,
    });
    expect(row.checkedInAt).toBeNull();
    expect(row.eventId).toBe(event.id);
  });

  it("never exposes ticket tokens or password hashes (assumption: not in spec)", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const attendee = await createUser();
    await seedRegistration(event.id, attendee.user.id, "REGISTERED");

    const response = await listEventRegistrations(event.id, token);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("ticketToken");
    expect(serialized).not.toContain("passwordHash");
  });

  it("leaves CANCELLED registrations out of the list (assumption: not in spec)", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const staying = await createUser({ name: "Staying" });
    const left = await createUser({ name: "Left" });
    await seedRegistration(event.id, staying.user.id, "REGISTERED");
    await seedRegistration(event.id, left.user.id, "CANCELLED");

    const response = await listEventRegistrations(event.id, token);

    expect(response.body.registrations).toHaveLength(1);
    expect(response.body.registrations[0].user.name).toBe("Staying");
    expect(response.body.pagination.total).toBe(1);
  });

  it("returns an empty list for an event with no registrations", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });

    const response = await listEventRegistrations(event.id, token);

    expect(response.status).toBe(200);
    expect(response.body.registrations).toEqual([]);
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it("lets an admin view any event's attendee list", async () => {
    const event = await createEvent();
    const attendee = await createUser();
    await seedRegistration(event.id, attendee.user.id, "REGISTERED");
    const { token: adminToken } = await createUser({ role: "ADMIN", label: "admin" });

    const response = await listEventRegistrations(event.id, adminToken);

    expect(response.status).toBe(200);
    expect(response.body.registrations).toHaveLength(1);
  });

  it("paginates with page and limit", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const attendees = await Promise.all(Array.from({ length: 5 }, () => createUser()));
    const t0 = Date.now() - 60 * 1000;
    for (const [i, attendee] of attendees.entries()) {
      await seedRegistration(event.id, attendee.user.id, "REGISTERED", {
        createdAt: new Date(t0 + i * 1000),
      });
    }

    const response = await listEventRegistrations(event.id, token, "?page=2&limit=2");

    expect(response.status).toBe(200);
    expect(response.body.registrations.map((r: { user: { id: string } }) => r.user.id)).toEqual([
      attendees[2].user.id,
      attendees[3].user.id,
    ]);
    expect(response.body.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it("rejects invalid pagination with 400 INVALID_PAGINATION", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });

    const response = await listEventRegistrations(event.id, token, "?page=0");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_PAGINATION");
  });

  it("rejects a regular user who is not the organizer with 403", async () => {
    const event = await createEvent();
    const { token } = await createUser();

    const response = await listEventRegistrations(event.id, token);

    expect(response.status).toBe(403);
  });

  it("rejects an attendee trying to see the attendee list with 403", async () => {
    const event = await createEvent();
    const attendee = await createUser();
    await seedRegistration(event.id, attendee.user.id, "REGISTERED");

    const response = await listEventRegistrations(event.id, attendee.token);

    expect(response.status).toBe(403);
  });

  it("rejects another event's organizer with 403", async () => {
    const event = await createEvent();
    const { user: otherOrganizer, token } = await createUser({ label: "other-organizer" });
    await createEvent({ organizerId: otherOrganizer.id });

    const response = await listEventRegistrations(event.id, token);

    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const event = await createEvent();

    const response = await listEventRegistrations(event.id);

    expect(response.status).toBe(401);
  });

  it("returns 404 for an event that does not exist", async () => {
    const { token } = await createUser();

    const response = await listEventRegistrations("00000000-0000-0000-0000-000000000000", token);

    expect(response.status).toBe(404);
  });
});

describe("GET /api/me/registrations", () => {
  it("splits the caller's registrations into upcoming and past by when the event ends", async () => {
    const { user, token } = await createUser();
    const future = await createEvent({ title: "Future", startsInHours: 48 });
    const past = await createEvent({ title: "Past", startsInHours: -48, durationHours: 3 });
    await seedRegistration(future.id, user.id, "REGISTERED");
    await seedRegistration(past.id, user.id, "REGISTERED");

    const response = await listMyRegistrations(token);

    expect(response.status).toBe(200);
    expect(response.body.upcoming.map((r: { event: { title: string } }) => r.event.title)).toEqual([
      "Future",
    ]);
    expect(response.body.past.map((r: { event: { title: string } }) => r.event.title)).toEqual([
      "Past",
    ]);
  });

  it("counts an event that has started but not ended as upcoming (assumption: not in spec)", async () => {
    const { user, token } = await createUser();
    const inProgress = await createEvent({
      title: "In Progress",
      startsInHours: -1,
      durationHours: 3,
    });
    await seedRegistration(inProgress.id, user.id, "REGISTERED");

    const response = await listMyRegistrations(token);

    expect(response.body.upcoming).toHaveLength(1);
    expect(response.body.upcoming[0].event.title).toBe("In Progress");
    expect(response.body.past).toHaveLength(0);
  });

  it("includes waitlist status and position", async () => {
    const { user, token } = await createUser();
    const seated = await createEvent({ title: "Seated" });
    const waitlisted = await createEvent({ title: "Waitlisted" });
    await seedRegistration(seated.id, user.id, "REGISTERED");
    await seedRegistration(waitlisted.id, user.id, "WAITLISTED", { waitlistPosition: 3 });

    const response = await listMyRegistrations(token);

    const byTitle = new Map(
      response.body.upcoming.map(
        (r: { event: { title: string }; status: string; waitlistPosition: number | null }) => [
          r.event.title,
          r,
        ],
      ),
    ) as Map<string, { status: string; waitlistPosition: number | null }>;
    expect(byTitle.get("Seated")).toMatchObject({ status: "REGISTERED", waitlistPosition: null });
    expect(byTitle.get("Waitlisted")).toMatchObject({ status: "WAITLISTED", waitlistPosition: 3 });
  });

  it("orders upcoming soonest-first and past most-recent-first", async () => {
    const { user, token } = await createUser();
    const events = {
      soon: await createEvent({ title: "Soon", startsInHours: 24 }),
      later: await createEvent({ title: "Later", startsInHours: 24 * 10 }),
      recentPast: await createEvent({ title: "Recent Past", startsInHours: -24 }),
      oldPast: await createEvent({ title: "Old Past", startsInHours: -24 * 10 }),
    };
    for (const event of Object.values(events)) {
      await seedRegistration(event.id, user.id, "REGISTERED");
    }

    const response = await listMyRegistrations(token);

    const titles = (rows: Array<{ event: { title: string } }>) => rows.map((r) => r.event.title);
    expect(titles(response.body.upcoming)).toEqual(["Soon", "Later"]);
    expect(titles(response.body.past)).toEqual(["Recent Past", "Old Past"]);
  });

  it("leaves out the caller's CANCELLED registrations (assumption: not in spec)", async () => {
    const { user, token } = await createUser();
    const kept = await createEvent({ title: "Kept" });
    const cancelled = await createEvent({ title: "Cancelled By User" });
    await seedRegistration(kept.id, user.id, "REGISTERED");
    await seedRegistration(cancelled.id, user.id, "CANCELLED");

    const response = await listMyRegistrations(token);

    expect(response.body.upcoming.map((r: { event: { title: string } }) => r.event.title)).toEqual([
      "Kept",
    ]);
    expect(response.body.past).toEqual([]);
  });

  it("still lists a registration for an event the organizer cancelled, with the event's status (assumption: not in spec)", async () => {
    const { user, token } = await createUser();
    const event = await createEvent({ title: "Called Off", status: "CANCELLED" });
    await seedRegistration(event.id, user.id, "REGISTERED");

    const response = await listMyRegistrations(token);

    expect(response.body.upcoming).toHaveLength(1);
    expect(response.body.upcoming[0].event.status).toBe("CANCELLED");
  });

  it("only returns the caller's own registrations", async () => {
    const { user: me, token } = await createUser();
    const { user: someoneElse } = await createUser();
    const mine = await createEvent({ title: "Mine" });
    const theirs = await createEvent({ title: "Theirs" });
    await seedRegistration(mine.id, me.id, "REGISTERED");
    await seedRegistration(theirs.id, someoneElse.id, "REGISTERED");

    const response = await listMyRegistrations(token);

    expect(response.body.upcoming.map((r: { event: { title: string } }) => r.event.title)).toEqual([
      "Mine",
    ]);
  });

  it("includes an event summary and the caller's own ticket token", async () => {
    const { user, token } = await createUser();
    const event = await createEvent({ title: "With Details" });
    const registration = await seedRegistration(event.id, user.id, "REGISTERED");

    const response = await listMyRegistrations(token);

    const [row] = response.body.upcoming;
    expect(row.id).toBe(registration.id);
    expect(row.event).toMatchObject({
      id: event.id,
      title: "With Details",
      venueName: "Test Hall",
      city: "Testville",
      timezone: "America/New_York",
      status: "PUBLISHED",
    });
    const decoded = verifyTicketToken(row.ticketToken);
    expect(decoded.registrationId).toBe(registration.id);
    expect(decoded.eventId).toBe(event.id);
  });

  it("returns empty lists for a user with no registrations", async () => {
    const { token } = await createUser();

    const response = await listMyRegistrations(token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ upcoming: [], past: [] });
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await listMyRegistrations();

    expect(response.status).toBe(401);
  });
});
