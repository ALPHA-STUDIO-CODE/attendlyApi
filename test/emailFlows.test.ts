import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import { signTicketToken } from "../src/auth/ticketToken";
import { recordEmailFailure, sendEmail, type SendEmailInput } from "../src/integrations/resend";

// Phase I2: the four flows really send email (through the wrapper, mocked
// here), and a failed send never fails the action that triggered it
// (spec §8.5). APP_BASE_URL is pinned by test/setupEnv.ts.
jest.mock("../src/integrations/resend", () => ({
  sendEmail: jest.fn(),
  recordEmailFailure: jest.fn(),
}));

const mockedSend = sendEmail as unknown as jest.Mock;
const mockedRecord = recordEmailFailure as unknown as jest.Mock;

const app = createApp();
const HOUR = 1000 * 60 * 60;
const BASE_URL = "https://attendly.example.test";

function sentEmails(): SendEmailInput[] {
  return mockedSend.mock.calls.map(([input]) => input as SendEmailInput);
}

/** Retries an assertion until it passes — for work the route does in the background. */
async function waitFor(assertion: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createUser(overrides: { name?: string; label?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `i2-${overrides.label ?? "user"}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: overrides.name ?? "I2 Test User",
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role: "USER" }) };
}

async function createEvent(
  overrides: { organizerId?: string; maxCapacity?: number; title?: string } = {},
) {
  const organizer = overrides.organizerId
    ? null
    : await createUser({ label: "organizer", name: "I2 Organizer" });
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 24 * 30 * HOUR);
  const event = await prisma.event.create({
    data: {
      organizerId: overrides.organizerId ?? organizer!.user.id,
      title: overrides.title ?? "I2 Email Event",
      description: "An event used to exercise the real email sends.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 3 * HOUR),
      maxCapacity: overrides.maxCapacity ?? 50,
    },
  });
  return { event, organizerToken: organizer?.token };
}

async function seedRegistration(
  eventId: string,
  userId: string,
  status: "REGISTERED" | "WAITLISTED" | "CANCELLED",
  waitlistPosition?: number,
) {
  const id = randomUUID();
  return prisma.registration.create({
    data: {
      id,
      eventId,
      userId,
      status,
      waitlistPosition: status === "WAITLISTED" ? (waitlistPosition ?? 1) : null,
      ticketToken: signTicketToken({ registrationId: id, eventId }),
    },
  });
}

function register(eventId: string, token: string) {
  return request(app)
    .post(`/api/events/${eventId}/register`)
    .set("Authorization", `Bearer ${token}`);
}

function cancelRegistration(eventId: string, token: string) {
  return request(app)
    .delete(`/api/events/${eventId}/register`)
    .set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  mockedSend.mockReset();
  mockedSend.mockResolvedValue({ ok: true, id: "email_1" });
  mockedRecord.mockReset();
  mockedRecord.mockResolvedValue({ ok: false, error: "recorded" });
});

describe("registration emails", () => {
  it("sends the registrant a confirmation with the event details and a link", async () => {
    const { event } = await createEvent({ title: "Confirmation Event" });
    const { user, token } = await createUser({ name: "Ada Lovelace" });

    const response = await register(event.id, token);

    expect(response.status).toBe(201);
    expect(response.body.warnings).toBe(undefined);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [sent] = sentEmails();
    expect(sent.kind).toBe("REGISTRATION_CONFIRMATION");
    expect(sent.to).toBe(user.email);
    expect(sent.relatedId).toBe(response.body.registration.id);
    expect(sent.subject).toBe("You're registered: Confirmation Event");
    expect(sent.html).toContain(`href="${BASE_URL}/events/${event.id}"`);
    expect(sent.text).toContain("Hi Ada Lovelace,");
    expect(sent.text).toContain("Where: Test Hall, 123 Test St, Testville");
  });

  it("sends a waitlisted registrant the waitlist notice with their position, not a confirmation", async () => {
    const { event } = await createEvent({ maxCapacity: 1 });
    const seated = await createUser();
    const waiting = await createUser();
    await register(event.id, seated.token);
    mockedSend.mockClear();

    const response = await register(event.id, waiting.token);

    expect(response.body.registration.status).toBe("WAITLISTED");
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [sent] = sentEmails();
    expect(sent.kind).toBe("WAITLIST_JOINED");
    expect(sent.to).toBe(waiting.user.email);
    expect(sent.text).toContain("You're number 1 on the waitlist.");
  });

  it("still registers the user, with a warning, when the email can't be sent", async () => {
    const { event } = await createEvent();
    const { user, token } = await createUser();
    mockedSend.mockResolvedValue({ ok: false, error: "Resend is down" });

    const response = await register(event.id, token);

    expect(response.status).toBe(201);
    expect(response.body.registration.status).toBe("REGISTERED");
    expect(response.body.warnings).toEqual(["confirmation email may be delayed"]);
    const row = await prisma.registration.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
    });
    expect(row?.status).toBe("REGISTERED");
  });
});

describe("waitlist promotion email", () => {
  it("emails the promoted user when a seat frees up", async () => {
    const { event } = await createEvent({ maxCapacity: 1, title: "Promotion Event" });
    const seated = await createUser();
    const waiting = await createUser({ name: "Next In Line" });
    await register(event.id, seated.token);
    const waitlisted = await register(event.id, waiting.token);
    mockedSend.mockClear();

    const response = await cancelRegistration(event.id, seated.token);

    expect(response.status).toBe(200);
    expect(response.body.warnings).toBe(undefined);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [sent] = sentEmails();
    expect(sent.kind).toBe("WAITLIST_PROMOTION");
    expect(sent.to).toBe(waiting.user.email);
    expect(sent.relatedId).toBe(waitlisted.body.registration.id);
    expect(sent.subject).toBe("A spot opened up: Promotion Event");
  });

  it("sends nothing when nobody is promoted", async () => {
    const { event } = await createEvent({ maxCapacity: 5 });
    const only = await createUser();
    await register(event.id, only.token);
    mockedSend.mockClear();

    await cancelRegistration(event.id, only.token);

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("still completes the cancellation and promotion when the promotion email fails", async () => {
    const { event } = await createEvent({ maxCapacity: 1 });
    const seated = await createUser();
    const waiting = await createUser();
    await register(event.id, seated.token);
    await register(event.id, waiting.token);
    mockedSend.mockResolvedValue({ ok: false, error: "Resend is down" });

    const response = await cancelRegistration(event.id, seated.token);

    expect(response.status).toBe(200);
    expect(response.body.registration.status).toBe("CANCELLED");
    const promoted = await prisma.registration.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: waiting.user.id } },
    });
    expect(promoted.status).toBe("REGISTERED");
  });
});

describe("event cancellation emails", () => {
  async function seedEventWithAttendees() {
    const { event, organizerToken } = await createEvent({ title: "Called Off Event" });
    const [seatedA, seatedB, waiting, left] = await Promise.all(
      ["Seated A", "Seated B", "Waiting", "Left"].map((name) => createUser({ name })),
    );
    const regA = await seedRegistration(event.id, seatedA.user.id, "REGISTERED");
    const regB = await seedRegistration(event.id, seatedB.user.id, "REGISTERED");
    const regW = await seedRegistration(event.id, waiting.user.id, "WAITLISTED", 1);
    await seedRegistration(event.id, left.user.id, "CANCELLED");
    return {
      event,
      organizerToken: organizerToken!,
      seatedA,
      seatedB,
      waiting,
      left,
      regA,
      regB,
      regW,
    };
  }

  function cancelEvent(eventId: string, token: string) {
    return request(app).delete(`/api/events/${eventId}`).set("Authorization", `Bearer ${token}`);
  }

  it("emails everyone registered or waitlisted — and nobody who already cancelled", async () => {
    const seed = await seedEventWithAttendees();

    const response = await cancelEvent(seed.event.id, seed.organizerToken);

    expect(response.status).toBe(200);
    expect(response.body.event.status).toBe("CANCELLED");
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(3));
    const recipients = sentEmails().map((sent) => sent.to);
    expect(recipients.sort()).toEqual(
      [seed.seatedA.user.email, seed.seatedB.user.email, seed.waiting.user.email].sort(),
    );
    expect(recipients).not.toContain(seed.left.user.email);
  });

  it("sends each one as an event-cancellation email with its own idempotency key", async () => {
    const seed = await seedEventWithAttendees();

    await cancelEvent(seed.event.id, seed.organizerToken);

    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(3));
    for (const sent of sentEmails()) {
      expect(sent.kind).toBe("EVENT_CANCELLATION");
      expect(sent.subject).toBe("Cancelled: Called Off Event");
      expect(sent.idempotencyKey).toBe(`event-cancellation/${sent.relatedId}`);
    }
    expect(
      sentEmails()
        .map((sent) => sent.relatedId)
        .sort(),
    ).toEqual([seed.regA.id, seed.regB.id, seed.regW.id].sort());
  });

  it("keeps going when one recipient's email fails, and still cancels the event", async () => {
    const seed = await seedEventWithAttendees();
    mockedSend
      .mockResolvedValueOnce({ ok: false, error: "bounced" })
      .mockResolvedValue({ ok: true, id: "email_1" });

    const response = await cancelEvent(seed.event.id, seed.organizerToken);

    expect(response.status).toBe(200);
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(3));
    const event = await prisma.event.findUniqueOrThrow({ where: { id: seed.event.id } });
    expect(event.status).toBe("CANCELLED");
  });

  it("sends nothing for an event with no registrations", async () => {
    const { event, organizerToken } = await createEvent();

    const response = await cancelEvent(event.id, organizerToken!);

    expect(response.status).toBe(200);
    await pause(150);
    expect(mockedSend).not.toHaveBeenCalled();
  });
});

describe("password reset email", () => {
  function forgotPassword(email: string) {
    return request(app).post("/api/auth/forgot-password").send({ email });
  }

  it("emails a reset link whose token actually resets the password", async () => {
    const { user } = await createUser({ name: "Ada Lovelace" });

    const response = await forgotPassword(user.email);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(1));
    const [sent] = sentEmails();
    expect(sent.kind).toBe("PASSWORD_RESET");
    expect(sent.to).toBe(user.email);
    expect(sent.relatedId).toBe(user.id);
    expect(sent.html).toContain(`${BASE_URL}/reset-password?token=`);

    const match = sent.text.match(/reset-password\?token=(\S+)/);
    expect(match).not.toBe(null);
    const token = decodeURIComponent(match![1]);
    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "a-brand-new-password-456" });
    expect(reset.status).toBe(200);
  });

  it("sends nothing for an unknown email, and answers exactly as it does for a known one", async () => {
    const { user } = await createUser();

    const known = await forgotPassword(user.email);
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(1));
    mockedSend.mockClear();
    const unknown = await forgotPassword(`nobody-${Date.now()}@example.com`);
    await pause(150);

    expect(mockedSend).not.toHaveBeenCalled();
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it("answers the same, and doesn't wait on the send, when the email fails", async () => {
    const { user } = await createUser();
    mockedSend.mockReturnValue(new Promise(() => {})); // a send that never finishes

    const response = await forgotPassword(user.email);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(1));
  });
});
