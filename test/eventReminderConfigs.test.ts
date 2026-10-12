import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";

const app = createApp();

async function createUser(label = "user") {
  const user = await prisma.user.create({
    data: {
      email: `k2-${label}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "K2 Test User",
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role: "USER" }) };
}

async function categoryId(): Promise<string> {
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  return category.id;
}

async function eventPayload(overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return {
    title: "K2 Reminder Event",
    description: "An event used to exercise reminder configuration.",
    categoryId: await categoryId(),
    venueName: "Test Hall",
    address: "123 Test St",
    city: "Testville",
    timezone: "America/New_York",
    date: start.toISOString(),
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3).toISOString(),
    maxCapacity: 100,
    ...overrides,
  };
}

async function createEventVia(token: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send(await eventPayload(overrides));
}

function patchEvent(eventId: string, token: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/events/${eventId}`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function storedConfigs(eventId: string) {
  return prisma.reminderConfig.findMany({ where: { eventId }, orderBy: { hoursBefore: "desc" } });
}

const hours = (...values: number[]) => values.map((hoursBefore) => ({ hoursBefore }));

describe("POST /api/events — reminder configs", () => {
  it("stores the reminders and returns them largest first, with no ids or sent flags", async () => {
    const { token } = await createUser("organizer");

    const response = await createEventVia(token, { reminderConfigs: hours(1, 24) });

    expect(response.status).toBe(201);
    expect(response.body.event.reminderConfigs).toEqual(hours(24, 1));
    const rows = await storedConfigs(response.body.event.id);
    expect(rows.map((row) => [row.hoursBefore, row.sent])).toEqual([
      [24, false],
      [1, false],
    ]);
  });

  it("defaults to no reminders when none are given", async () => {
    const { token } = await createUser("organizer");

    const response = await createEventVia(token);

    expect(response.status).toBe(201);
    expect(response.body.event.reminderConfigs).toEqual([]);
    expect(await storedConfigs(response.body.event.id)).toHaveLength(0);
  });

  it("accepts the limits: 1 and 720 hours, and five reminders", async () => {
    const { token } = await createUser("organizer");

    const response = await createEventVia(token, { reminderConfigs: hours(720, 168, 24, 2, 1) });

    expect(response.status).toBe(201);
    expect(response.body.event.reminderConfigs).toEqual(hours(720, 168, 24, 2, 1));
  });

  it.each([
    ["zero hours", [{ hoursBefore: 0 }], "reminderConfigs.0.hoursBefore"],
    ["a negative number", [{ hoursBefore: -5 }], "reminderConfigs.0.hoursBefore"],
    ["more than 720 hours", [{ hoursBefore: 721 }], "reminderConfigs.0.hoursBefore"],
    ["a fractional number", [{ hoursBefore: 1.5 }], "reminderConfigs.0.hoursBefore"],
    ["a string", [{ hoursBefore: "24" }], "reminderConfigs.0.hoursBefore"],
    ["a missing hoursBefore", [{}], "reminderConfigs.0.hoursBefore"],
    ["a duplicate offset", hours(24, 24), "reminderConfigs.1.hoursBefore"],
    ["six reminders", hours(1, 2, 3, 4, 5, 6), "reminderConfigs"],
    ["something that isn't a list", "nope", "reminderConfigs"],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, reminderConfigs, field) => {
    const { token } = await createUser("organizer");

    const response = await createEventVia(token, { reminderConfigs });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(response.body.error.details.fields)).toContain(field);
  });
});

describe("PATCH /api/events/:id — reminder configs", () => {
  async function eventWithReminders(...offsets: number[]) {
    const organizer = await createUser("organizer");
    const created = await createEventVia(organizer.token, { reminderConfigs: hours(...offsets) });
    return { ...organizer, eventId: created.body.event.id as string };
  }

  it("replaces the set: old ones gone, new ones present", async () => {
    const { token, eventId } = await eventWithReminders(24, 1);

    const response = await patchEvent(eventId, token, { reminderConfigs: hours(12) });

    expect(response.status).toBe(200);
    expect(response.body.event.reminderConfigs).toEqual(hours(12));
    expect((await storedConfigs(eventId)).map((row) => row.hoursBefore)).toEqual([12]);
  });

  it("keeps a reminder that is still wanted, with its sent flag — so a re-save can't re-send it", async () => {
    const { token, eventId } = await eventWithReminders(24, 1);
    await prisma.reminderConfig.updateMany({
      where: { eventId, hoursBefore: 24 },
      data: { sent: true },
    });
    const [before24] = await prisma.reminderConfig.findMany({
      where: { eventId, hoursBefore: 24 },
    });

    const response = await patchEvent(eventId, token, { reminderConfigs: hours(24, 6) });

    expect(response.status).toBe(200);
    const rows = await storedConfigs(eventId);
    expect(rows.map((row) => [row.hoursBefore, row.sent])).toEqual([
      [24, true],
      [6, false],
    ]);
    expect(rows[0].id).toBe(before24.id);
  });

  it("changes nothing when the same set is sent again", async () => {
    const { token, eventId } = await eventWithReminders(24, 1);
    await prisma.reminderConfig.updateMany({ where: { eventId }, data: { sent: true } });
    const before = await storedConfigs(eventId);

    await patchEvent(eventId, token, { reminderConfigs: hours(24, 1) });

    const after = await storedConfigs(eventId);
    expect(after.map((row) => [row.id, row.sent])).toEqual(before.map((row) => [row.id, true]));
  });

  it("leaves reminders alone when the edit doesn't mention them", async () => {
    const { token, eventId } = await eventWithReminders(24, 1);
    const before = await storedConfigs(eventId);

    const response = await patchEvent(eventId, token, { title: "A new title" });

    expect(response.status).toBe(200);
    expect(response.body.event.title).toBe("A new title");
    expect(response.body.event.reminderConfigs).toEqual(hours(24, 1));
    expect((await storedConfigs(eventId)).map((row) => row.id)).toEqual(
      before.map((row) => row.id),
    );
  });

  it("clears every reminder when given an empty list", async () => {
    const { token, eventId } = await eventWithReminders(24, 1);

    const response = await patchEvent(eventId, token, { reminderConfigs: [] });

    expect(response.status).toBe(200);
    expect(response.body.event.reminderConfigs).toEqual([]);
    expect(await storedConfigs(eventId)).toHaveLength(0);
  });

  it("updates the event's fields and its reminders together", async () => {
    const { token, eventId } = await eventWithReminders(24);

    const response = await patchEvent(eventId, token, {
      title: "Both at once",
      reminderConfigs: hours(2),
    });

    expect(response.status).toBe(200);
    expect(response.body.event.title).toBe("Both at once");
    expect(response.body.event.reminderConfigs).toEqual(hours(2));
  });

  it("rejects an invalid list with 400 and leaves the stored reminders as they were", async () => {
    const { token, eventId } = await eventWithReminders(24, 1);

    const response = await patchEvent(eventId, token, { reminderConfigs: hours(6, 6) });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect((await storedConfigs(eventId)).map((row) => row.hoursBefore)).toEqual([24, 1]);
  });

  it("allows changing reminders after people have registered (they are not a locked field)", async () => {
    const { token, eventId } = await eventWithReminders(24);
    await prisma.event.update({ where: { id: eventId }, data: { isLocked: true } });

    const response = await patchEvent(eventId, token, { reminderConfigs: hours(3) });

    expect(response.status).toBe(200);
    expect(response.body.event.reminderConfigs).toEqual(hours(3));
  });

  it("changes nothing when the same edit also touches a locked field", async () => {
    const { token, eventId } = await eventWithReminders(24);
    await prisma.event.update({ where: { id: eventId }, data: { isLocked: true } });

    const response = await patchEvent(eventId, token, {
      venueName: "Somewhere else",
      reminderConfigs: hours(3),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EVENT_LOCKED");
    expect((await storedConfigs(eventId)).map((row) => row.hoursBefore)).toEqual([24]);
  });

  it("does not let someone else's account change the reminders", async () => {
    const { eventId } = await eventWithReminders(24);
    const { token: stranger } = await createUser("stranger");

    const response = await patchEvent(eventId, stranger, { reminderConfigs: hours(1) });

    expect(response.status).toBe(403);
    expect((await storedConfigs(eventId)).map((row) => row.hoursBefore)).toEqual([24]);
  });
});

describe("GET /api/events/:id — reminder configs", () => {
  it("includes them for anyone, largest first, without ids or sent flags", async () => {
    const { token } = await createUser("organizer");
    const created = await createEventVia(token, { reminderConfigs: hours(1, 24, 6) });

    const response = await request(app).get(`/api/events/${created.body.event.id}`);

    expect(response.status).toBe(200);
    expect(response.body.event.reminderConfigs).toEqual(hours(24, 6, 1));
  });

  it("gives an empty list for an event with no reminders", async () => {
    const { token } = await createUser("organizer");
    const created = await createEventVia(token);

    const response = await request(app).get(`/api/events/${created.body.event.id}`);

    expect(response.body.event.reminderConfigs).toEqual([]);
  });
});
