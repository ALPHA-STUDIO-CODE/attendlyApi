import { randomUUID } from "crypto";
import { prisma } from "../src/db/prisma";
import { signTicketToken } from "../src/auth/ticketToken";
import { runReminderJob } from "../src/jobs/reminderJob";

// Phase K3 against the real database. Only the Resend SDK is mocked, so the
// real wrapper runs and failed sends really land in the FailedEmail table.
// Every run is limited to the event under test (`eventId`), so these tests
// can't claim reminders belonging to other test files.
const mockSend = jest.fn();
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));

const ORIGINAL_ENV = { ...process.env };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Attendly <noreply@example.com>";
  mockSend.mockReset();
  mockSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function createUser(name = "K3 Attendee") {
  return prisma.user.create({
    data: {
      email: `k3-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name,
    },
  });
}

/** An event that starts `startsInMinutes` from now (negative: already started). */
async function createEvent(
  overrides: { startsInMinutes?: number; status?: "PUBLISHED" | "CANCELLED"; title?: string } = {},
) {
  const organizer = await createUser("K3 Organizer");
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + (overrides.startsInMinutes ?? 30) * MINUTE);
  return prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: overrides.title ?? "K3 Reminder Event",
      description: "An event used to exercise the reminder job.",
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

async function addReminder(eventId: string, hoursBefore: number) {
  return prisma.reminderConfig.create({ data: { eventId, hoursBefore } });
}

async function addRegistration(
  eventId: string,
  status: "REGISTERED" | "WAITLISTED" | "CANCELLED",
  name?: string,
) {
  const user = await createUser(name);
  const id = randomUUID();
  const registration = await prisma.registration.create({
    data: {
      id,
      eventId,
      userId: user.id,
      status,
      waitlistPosition: status === "WAITLISTED" ? 1 : null,
      ticketToken: signTicketToken({ registrationId: id, eventId }),
    },
  });
  return { user, registration };
}

function sentTo(): string[] {
  return mockSend.mock.calls.map(([payload]) => (payload as { to: string }).to);
}

function isSent(configId: string) {
  return prisma.reminderConfig
    .findUniqueOrThrow({ where: { id: configId } })
    .then((config) => config.sent);
}

describe("runReminderJob", () => {
  it("emails the registered attendees — not the waitlisted or cancelled — and marks it sent", async () => {
    const event = await createEvent({ title: "Reminder Recipients" });
    const config = await addReminder(event.id, 1); // event in 30 min, so due 30 min ago
    const seatedA = await addRegistration(event.id, "REGISTERED", "Ada Lovelace");
    const seatedB = await addRegistration(event.id, "REGISTERED");
    await addRegistration(event.id, "WAITLISTED");
    await addRegistration(event.id, "CANCELLED");

    const summary = await runReminderJob({ eventId: event.id });

    expect(sentTo().sort()).toEqual([seatedA.user.email, seatedB.user.email].sort());
    const [payload] = mockSend.mock.calls[0];
    expect(payload.subject).toMatch(/^Reminder: Reminder Recipients on /);
    expect(payload.text).toContain("is coming up");
    expect(await isSent(config.id)).toBe(true);
    expect(summary).toMatchObject({ due: 1, claimed: 1, recipients: 2, sent: 2, failed: 0 });
  });

  it("leaves a reminder that isn't due yet completely alone", async () => {
    const event = await createEvent({ startsInMinutes: 5 * 60 });
    const config = await addReminder(event.id, 1); // due in 4 hours
    await addRegistration(event.id, "REGISTERED");

    const summary = await runReminderJob({ eventId: event.id });

    expect(mockSend).not.toHaveBeenCalled();
    expect(await isSent(config.id)).toBe(false);
    expect(summary).toMatchObject({ checked: 1, due: 0 });
  });

  it("sends only the reminders that are due when an event has several", async () => {
    const event = await createEvent({ startsInMinutes: 3 * 60 });
    const dueConfig = await addReminder(event.id, 24); // overdue, event hasn't started
    const laterConfig = await addReminder(event.id, 1); // due in 2 hours
    await addRegistration(event.id, "REGISTERED");

    await runReminderJob({ eventId: event.id });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await isSent(dueConfig.id)).toBe(true);
    expect(await isSent(laterConfig.id)).toBe(false);
  });

  it("marks a due reminder sent without emailing once the event has started", async () => {
    const event = await createEvent({ startsInMinutes: -10 });
    const config = await addReminder(event.id, 1);
    await addRegistration(event.id, "REGISTERED");

    const summary = await runReminderJob({ eventId: event.id });

    expect(mockSend).not.toHaveBeenCalled();
    expect(await isSent(config.id)).toBe(true);
    expect(summary).toMatchObject({ claimed: 1, skipped: 1, sent: 0 });
  });

  it("marks a due reminder sent without emailing when the event was cancelled", async () => {
    const event = await createEvent({ status: "CANCELLED" });
    const config = await addReminder(event.id, 1);
    await addRegistration(event.id, "REGISTERED");

    await runReminderJob({ eventId: event.id });

    expect(mockSend).not.toHaveBeenCalled();
    expect(await isSent(config.id)).toBe(true);
  });

  it("never sends the same reminder twice, however many times it runs", async () => {
    const event = await createEvent();
    await addReminder(event.id, 1);
    await addRegistration(event.id, "REGISTERED");

    await runReminderJob({ eventId: event.id });
    await runReminderJob({ eventId: event.id });
    await runReminderJob({ eventId: event.id });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("sends each recipient exactly one email when two runs overlap", async () => {
    const event = await createEvent();
    await addReminder(event.id, 1);
    await addRegistration(event.id, "REGISTERED");
    await addRegistration(event.id, "REGISTERED");
    await addRegistration(event.id, "REGISTERED");

    const [a, b] = await Promise.all([
      runReminderJob({ eventId: event.id }),
      runReminderJob({ eventId: event.id }),
    ]);

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(new Set(sentTo()).size).toBe(3);
    expect(a.claimed + b.claimed).toBe(1);
  });

  it("dead-letters a recipient whose send failed, keeps going, and never retries by itself", async () => {
    const event = await createEvent();
    const config = await addReminder(event.id, 1);
    const first = await addRegistration(event.id, "REGISTERED");
    const second = await addRegistration(event.id, "REGISTERED");
    const third = await addRegistration(event.id, "REGISTERED");
    mockSend
      .mockResolvedValueOnce({ data: { id: "email_1" }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { name: "validation_error", message: "bounced" },
      })
      .mockResolvedValueOnce({ data: { id: "email_3" }, error: null });

    const summary = await runReminderJob({ eventId: event.id });
    await runReminderJob({ eventId: event.id });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ sent: 2, failed: 1 });
    expect(await isSent(config.id)).toBe(true);
    const registrationIds = [first, second, third].map((r) => r.registration.id);
    const failed = await prisma.failedEmail.findMany({
      where: { kind: "EVENT_REMINDER", relatedId: { in: registrationIds } },
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      recipient: second.user.email,
      relatedId: second.registration.id,
    });
    expect(failed[0].errorMessage).toContain("bounced");
  });

  it("survives a send that throws part-way, and the next run doesn't re-send to anyone", async () => {
    const event = await createEvent();
    const config = await addReminder(event.id, 1);
    await addRegistration(event.id, "REGISTERED");
    await addRegistration(event.id, "REGISTERED");
    await addRegistration(event.id, "REGISTERED");
    mockSend
      .mockResolvedValueOnce({ data: { id: "email_1" }, error: null })
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ data: { id: "email_3" }, error: null });

    await expect(runReminderJob({ eventId: event.id })).resolves.toMatchObject({
      sent: 2,
      failed: 1,
    });
    await runReminderJob({ eventId: event.id });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(await isSent(config.id)).toBe(true);
  });

  it("only touches the event it was asked about", async () => {
    const mine = await createEvent();
    const other = await createEvent();
    await addReminder(mine.id, 1);
    const otherConfig = await addReminder(other.id, 1);
    await addRegistration(mine.id, "REGISTERED");
    await addRegistration(other.id, "REGISTERED");

    await runReminderJob({ eventId: mine.id });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await isSent(otherConfig.id)).toBe(false);
  });
});
