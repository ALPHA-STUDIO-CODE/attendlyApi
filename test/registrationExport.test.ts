import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { signTicketToken } from "../src/auth/ticketToken";

const app = createApp();

const HOUR = 1000 * 60 * 60;
const BOM = "\uFEFF";
const HEADER = "Name,Email,Status,Waitlist position,Registered at,Checked in at";

async function createUser(
  overrides: { name?: string; role?: "USER" | "ADMIN"; label?: string } = {},
) {
  const role = overrides.role ?? "USER";
  const user = await prisma.user.create({
    data: {
      email: `h5-${overrides.label ?? "user"}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: overrides.name ?? "H5 Test User",
      role,
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role }) };
}

async function createEvent(
  overrides: {
    organizerId?: string;
    title?: string;
    status?: "PUBLISHED" | "CANCELLED";
  } = {},
) {
  const organizerId = overrides.organizerId ?? (await createUser({ label: "organizer" })).user.id;
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 24 * 30 * HOUR);
  return prisma.event.create({
    data: {
      organizerId,
      title: overrides.title ?? "H5 Export Event",
      description: "An event used to exercise the attendee CSV export.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 3 * HOUR),
      maxCapacity: 50,
      status: overrides.status ?? "PUBLISHED",
    },
  });
}

async function seedRegistration(
  eventId: string,
  userId: string,
  status: "REGISTERED" | "WAITLISTED" | "CANCELLED",
  extras: { waitlistPosition?: number; createdAt?: Date; checkedInAt?: Date } = {},
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
      ...(extras.checkedInAt ? { checkedInAt: extras.checkedInAt } : {}),
    },
  });
}

/**
 * Success-path request that keeps the raw bytes (superagent would otherwise
 * decode the body itself), so the BOM can be asserted on exactly.
 */
async function exportCsv(eventId: string, token: string) {
  const response = await request(app)
    .get(`/api/events/${eventId}/registrations/export`)
    .set("Authorization", `Bearer ${token}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  const bytes = response.body as Buffer;
  return { response, bytes, text: bytes.toString("utf8") };
}

function requestExport(eventId: string, token?: string) {
  const req = request(app).get(`/api/events/${eventId}/registrations/export`);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
}

describe("GET /api/events/:id/registrations/export", () => {
  it("returns a CSV attachment with the right headers for the organizer", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id, title: "Tech Meetup 2026" });

    const { response } = await exportCsv(event.id, token);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="attendees-tech-meetup-2026.csv"',
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("starts with a UTF-8 BOM and the header row, with CRLF line endings", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });

    const { bytes, text } = await exportCsv(event.id, token);

    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toBe(`${BOM}${HEADER}\r\n`);
  });

  it("lists seated attendees first, then the waitlist in queue order, with all columns", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const [seatedLate, seatedEarly, waitSecond, waitFirst] = await Promise.all(
      ["Seated Late", "Seated Early", "Wait Second", "Wait First"].map((name) =>
        createUser({ name }),
      ),
    );
    const t0 = Date.now() - 10 * 60 * 1000;
    const checkedInAt = new Date(t0 + 5 * 60 * 1000);
    const regSeatedLate = await seedRegistration(event.id, seatedLate.user.id, "REGISTERED", {
      createdAt: new Date(t0 + 1000),
    });
    const regSeatedEarly = await seedRegistration(event.id, seatedEarly.user.id, "REGISTERED", {
      createdAt: new Date(t0),
      checkedInAt,
    });
    const regWaitSecond = await seedRegistration(event.id, waitSecond.user.id, "WAITLISTED", {
      waitlistPosition: 2,
      createdAt: new Date(t0 + 3000),
    });
    const regWaitFirst = await seedRegistration(event.id, waitFirst.user.id, "WAITLISTED", {
      waitlistPosition: 1,
      createdAt: new Date(t0 + 2000),
    });

    const { text } = await exportCsv(event.id, token);

    const expected = [
      HEADER,
      `Seated Early,${seatedEarly.user.email},REGISTERED,,${regSeatedEarly.createdAt.toISOString()},${checkedInAt.toISOString()}`,
      `Seated Late,${seatedLate.user.email},REGISTERED,,${regSeatedLate.createdAt.toISOString()},`,
      `Wait First,${waitFirst.user.email},WAITLISTED,1,${regWaitFirst.createdAt.toISOString()},`,
      `Wait Second,${waitSecond.user.email},WAITLISTED,2,${regWaitSecond.createdAt.toISOString()},`,
      "",
    ].join("\r\n");
    expect(text).toBe(`${BOM}${expected}`);
  });

  it("matches the order of the on-screen attendee list", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const users = await Promise.all(
      ["Zed", "Amy", "Bob", "Cat"].map((name) => createUser({ name })),
    );
    const t0 = Date.now() - 60 * 1000;
    await seedRegistration(event.id, users[0].user.id, "REGISTERED", {
      createdAt: new Date(t0),
    });
    await seedRegistration(event.id, users[1].user.id, "WAITLISTED", {
      waitlistPosition: 2,
      createdAt: new Date(t0 + 1000),
    });
    await seedRegistration(event.id, users[2].user.id, "REGISTERED", {
      createdAt: new Date(t0 + 2000),
    });
    await seedRegistration(event.id, users[3].user.id, "WAITLISTED", {
      waitlistPosition: 1,
      createdAt: new Date(t0 + 3000),
    });

    const list = await request(app)
      .get(`/api/events/${event.id}/registrations`)
      .set("Authorization", `Bearer ${token}`);
    const { text } = await exportCsv(event.id, token);

    const listedNames = list.body.registrations.map((r: { user: { name: string } }) => r.user.name);
    const exportedNames = text
      .replace(BOM, "")
      .split("\r\n")
      .slice(1, -1)
      .map((line) => line.split(",")[0]);
    expect(exportedNames).toEqual(listedNames);
  });

  it("leaves CANCELLED registrations out", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const staying = await createUser({ name: "Staying" });
    const left = await createUser({ name: "Left" });
    await seedRegistration(event.id, staying.user.id, "REGISTERED");
    await seedRegistration(event.id, left.user.id, "CANCELLED");

    const { text } = await exportCsv(event.id, token);

    expect(text).toContain("Staying,");
    expect(text).not.toContain("Left,");
    expect(text).not.toContain("CANCELLED");
  });

  it("never includes ticket tokens", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const attendee = await createUser();
    const registration = await seedRegistration(event.id, attendee.user.id, "REGISTERED");

    const { text } = await exportCsv(event.id, token);

    expect(text).not.toContain(registration.ticketToken);
    expect(text.toLowerCase()).not.toContain("token");
    expect(text).not.toContain("passwordHash");
  });

  it("neutralises formula characters in attendee names, end to end", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const attacker = await createUser({ name: '=HYPERLINK("http://evil.example","click")' });
    await seedRegistration(event.id, attacker.user.id, "REGISTERED");

    const { text } = await exportCsv(event.id, token);

    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")",`);
    expect(text).not.toMatch(/(^|\r\n)=/);
    expect(text).not.toContain(",=HYPERLINK");
  });

  it("quotes names containing commas and keeps non-ASCII names intact", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });
    const commaName = await createUser({ name: "Lovelace, Ada" });
    const accentName = await createUser({ name: "José Müller" });
    await seedRegistration(event.id, commaName.user.id, "REGISTERED", {
      createdAt: new Date(Date.now() - 2000),
    });
    await seedRegistration(event.id, accentName.user.id, "REGISTERED", {
      createdAt: new Date(Date.now() - 1000),
    });

    const { text } = await exportCsv(event.id, token);

    expect(text).toContain('"Lovelace, Ada",');
    expect(text).toContain("José Müller,");
  });

  it("returns just the header row for an event with no attendees", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id });

    const { response, text } = await exportCsv(event.id, token);

    expect(response.status).toBe(200);
    expect(text).toBe(`${BOM}${HEADER}\r\n`);
  });

  it("falls back to the event id in the filename when the title has no usable characters", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id, title: "会議" });

    const { response } = await exportCsv(event.id, token);

    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="attendees-${event.id}.csv"`,
    );
  });

  it("still works after the organizer has cancelled the event", async () => {
    const { user: organizer, token } = await createUser({ label: "organizer" });
    const event = await createEvent({ organizerId: organizer.id, status: "CANCELLED" });
    const attendee = await createUser({ name: "Still Listed" });
    await seedRegistration(event.id, attendee.user.id, "REGISTERED");

    const { response, text } = await exportCsv(event.id, token);

    expect(response.status).toBe(200);
    expect(text).toContain("Still Listed,");
  });

  it("lets an admin export any event's attendees", async () => {
    const event = await createEvent();
    const attendee = await createUser({ name: "Admin Visible" });
    await seedRegistration(event.id, attendee.user.id, "REGISTERED");
    const { token: adminToken } = await createUser({ role: "ADMIN", label: "admin" });

    const { response, text } = await exportCsv(event.id, adminToken);

    expect(response.status).toBe(200);
    expect(text).toContain("Admin Visible,");
  });

  it("rejects a regular user who is not the organizer with 403", async () => {
    const event = await createEvent();
    const { token } = await createUser();

    const response = await requestExport(event.id, token);

    expect(response.status).toBe(403);
  });

  it("rejects an attendee trying to export with 403", async () => {
    const event = await createEvent();
    const attendee = await createUser();
    await seedRegistration(event.id, attendee.user.id, "REGISTERED");

    const response = await requestExport(event.id, attendee.token);

    expect(response.status).toBe(403);
  });

  it("rejects another event's organizer with 403", async () => {
    const event = await createEvent();
    const { user: otherOrganizer, token } = await createUser({ label: "other-organizer" });
    await createEvent({ organizerId: otherOrganizer.id });

    const response = await requestExport(event.id, token);

    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const event = await createEvent();

    const response = await requestExport(event.id);

    expect(response.status).toBe(401);
  });

  it("returns 404 for an event that does not exist", async () => {
    const { token } = await createUser();

    const response = await requestExport("00000000-0000-0000-0000-000000000000", token);

    expect(response.status).toBe(404);
  });
});
