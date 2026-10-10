import type { User } from "@prisma/client";
import { prisma } from "../../src/db/prisma";
import { recordEmailFailure, sendEmail } from "../../src/integrations/resend";
import { logger } from "../../src/logger";
import { deliver } from "../../src/email/deliver";
import { queueCancellationEmails } from "../../src/email/queueCancellationEmails";
import { queueRegistrationConfirmationEmail } from "../../src/email/queueRegistrationConfirmationEmail";
import { sendPasswordResetEmail } from "../../src/email/sendPasswordResetEmail";

// The wrapper, the database and the logger are mocked: these tests cover the
// seams' own logic — which email goes to whom, never throwing, and what is
// (not) recorded or logged.
jest.mock("../../src/integrations/resend", () => ({
  sendEmail: jest.fn(),
  recordEmailFailure: jest.fn(),
}));
jest.mock("../../src/db/prisma", () => ({
  prisma: {
    registration: { findUnique: jest.fn(), findMany: jest.fn() },
    event: { findUnique: jest.fn() },
  },
}));
jest.mock("../../src/logger", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockedSend = sendEmail as unknown as jest.Mock;
const mockedRecord = recordEmailFailure as unknown as jest.Mock;
const mockedFindRegistration = prisma.registration.findUnique as unknown as jest.Mock;
const mockedFindRegistrations = prisma.registration.findMany as unknown as jest.Mock;
const mockedFindEvent = prisma.event.findUnique as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const EVENT = {
  id: "evt-1",
  title: "Tech Meetup",
  startTime: new Date("2026-11-07T23:00:00.000Z"),
  endTime: new Date("2026-11-08T02:00:00.000Z"),
  timezone: "America/New_York",
  venueName: "Test Hall",
  address: "123 Test St",
  city: "Testville",
};
const USER = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" };

function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg-1",
    status: "REGISTERED",
    waitlistPosition: null,
    user: USER,
    event: EVENT,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.APP_BASE_URL = "https://attendly.example.test";
  process.env.NODE_ENV = "test";
  mockedSend.mockResolvedValue({ ok: true, id: "email_1" });
  mockedRecord.mockImplementation((_input: unknown, error: string) =>
    Promise.resolve({ ok: false, error }),
  );
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("deliver", () => {
  const params = {
    kind: "REGISTRATION_CONFIRMATION" as const,
    to: "ada@example.com",
    relatedId: "reg-1",
    idempotencyKey: "key-1",
  };

  it("sends the built content with the routing fields and returns the result", async () => {
    const result = await deliver({
      ...params,
      build: () => ({ subject: "S", html: "<p>H</p>", text: "T" }),
    });

    expect(result).toEqual({ ok: true, id: "email_1" });
    expect(mockedSend).toHaveBeenCalledWith({
      kind: "REGISTRATION_CONFIRMATION",
      to: "ada@example.com",
      relatedId: "reg-1",
      idempotencyKey: "key-1",
      subject: "S",
      html: "<p>H</p>",
      text: "T",
    });
  });

  it("dead-letters an email it could not build, without sending, and does not throw", async () => {
    const result = await deliver({
      ...params,
      build: () => {
        throw new Error("APP_BASE_URL is not set");
      },
    });

    expect(result).toEqual({ ok: false, error: "APP_BASE_URL is not set" });
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedRecord).toHaveBeenCalledWith(
      {
        kind: "REGISTRATION_CONFIRMATION",
        to: "ada@example.com",
        subject: "(not built) REGISTRATION_CONFIRMATION",
        relatedId: "reg-1",
      },
      "APP_BASE_URL is not set",
    );
  });
});

describe("queueRegistrationConfirmationEmail", () => {
  it("sends a confirmation to a seated attendee", async () => {
    mockedFindRegistration.mockResolvedValue(registration());

    const result = await queueRegistrationConfirmationEmail("reg-1");

    expect(result).toEqual({ ok: true, id: "email_1" });
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const sent = mockedSend.mock.calls[0][0];
    expect(sent.kind).toBe("REGISTRATION_CONFIRMATION");
    expect(sent.to).toBe("ada@example.com");
    expect(sent.relatedId).toBe("reg-1");
    expect(sent.subject).toBe("You're registered: Tech Meetup");
    expect(sent.idempotencyKey).toBe(undefined);
  });

  it("sends the waitlist notice, with position, to a waitlisted registrant", async () => {
    mockedFindRegistration.mockResolvedValue(
      registration({ status: "WAITLISTED", waitlistPosition: 2 }),
    );

    await queueRegistrationConfirmationEmail("reg-1");

    const sent = mockedSend.mock.calls[0][0];
    expect(sent.kind).toBe("WAITLIST_JOINED");
    expect(sent.text).toContain("You're number 2 on the waitlist.");
  });

  it("sends the promotion email when promotedFromWaitlist is set", async () => {
    mockedFindRegistration.mockResolvedValue(registration({ status: "REGISTERED" }));

    await queueRegistrationConfirmationEmail("reg-1", { promotedFromWaitlist: true });

    const sent = mockedSend.mock.calls[0][0];
    expect(sent.kind).toBe("WAITLIST_PROMOTION");
    expect(sent.subject).toBe("A spot opened up: Tech Meetup");
  });

  it("passes a failed send result back so the route can add a warning", async () => {
    mockedFindRegistration.mockResolvedValue(registration());
    mockedSend.mockResolvedValue({ ok: false, error: "Resend is down" });

    const result = await queueRegistrationConfirmationEmail("reg-1");

    expect(result).toEqual({ ok: false, error: "Resend is down" });
  });

  it("resolves ok:false, without sending, when the registration does not exist", async () => {
    mockedFindRegistration.mockResolvedValue(null);

    const result = await queueRegistrationConfirmationEmail("missing");

    expect(result).toEqual({ ok: false, error: "Registration not found." });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("never throws when the database read fails", async () => {
    mockedFindRegistration.mockRejectedValue(new Error("database is down"));

    const result = await queueRegistrationConfirmationEmail("reg-1");

    expect(result).toEqual({ ok: false, error: "database is down" });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("dead-letters the email when APP_BASE_URL is missing in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_BASE_URL;
    mockedFindRegistration.mockResolvedValue(registration());

    const result = await queueRegistrationConfirmationEmail("reg-1");

    expect(result.ok).toBe(false);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "REGISTRATION_CONFIRMATION",
        to: "ada@example.com",
        relatedId: "reg-1",
      }),
      expect.stringContaining("APP_BASE_URL"),
    );
  });
});

describe("queueCancellationEmails", () => {
  const registrations = ["a", "b", "c"].map((letter) => ({
    id: `reg-${letter}`,
    user: { name: `User ${letter.toUpperCase()}`, email: `${letter}@example.com` },
  }));

  beforeEach(() => {
    mockedFindEvent.mockResolvedValue(EVENT);
    mockedFindRegistrations.mockResolvedValue(registrations);
  });

  it("emails every active registrant, with a per-registration idempotency key", async () => {
    const summary = await queueCancellationEmails("evt-1");

    expect(summary).toEqual({ total: 3, sent: 3, failed: 0 });
    expect(mockedSend.mock.calls.map(([sent]) => sent.to)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    const [first] = mockedSend.mock.calls[0];
    expect(first.kind).toBe("EVENT_CANCELLATION");
    expect(first.relatedId).toBe("reg-a");
    expect(first.idempotencyKey).toBe("event-cancellation/reg-a");
    expect(first.subject).toBe("Cancelled: Tech Meetup");
  });

  it("only looks at registered and waitlisted rows, never cancelled ones", async () => {
    await queueCancellationEmails("evt-1");

    expect(mockedFindRegistrations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "evt-1", status: { in: ["REGISTERED", "WAITLISTED"] } },
      }),
    );
  });

  it("sends one at a time, to stay inside Resend's rate limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockedSend.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, id: "email_1" };
    });

    await queueCancellationEmails("evt-1");

    expect(mockedSend).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it("carries on after one send fails, and counts it", async () => {
    let call = 0;
    mockedSend.mockImplementation(async () => {
      call += 1;
      return call === 1 ? { ok: false, error: "bounced" } : { ok: true, id: "email_1" };
    });

    const summary = await queueCancellationEmails("evt-1");

    expect(mockedSend).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({ total: 3, sent: 2, failed: 1 });
  });

  it("sends nothing and does not throw when the event is gone", async () => {
    mockedFindEvent.mockResolvedValue(null);

    const summary = await queueCancellationEmails("evt-1");

    expect(summary).toEqual({ total: 0, sent: 0, failed: 0 });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("sends nothing for an event with no active registrations", async () => {
    mockedFindRegistrations.mockResolvedValue([]);

    const summary = await queueCancellationEmails("evt-1");

    expect(summary).toEqual({ total: 0, sent: 0, failed: 0 });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("never rejects when the database fails, and keeps the progress made so far", async () => {
    mockedFindRegistrations.mockRejectedValue(new Error("database is down"));

    await expect(queueCancellationEmails("evt-1")).resolves.toEqual({
      total: 0,
      sent: 0,
      failed: 0,
    });
  });
});

describe("sendPasswordResetEmail", () => {
  const user = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" } as User;

  it("emails a reset link built from APP_BASE_URL, with the token URL-encoded", async () => {
    await sendPasswordResetEmail(user, "tok/en+1");

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const sent = mockedSend.mock.calls[0][0];
    expect(sent.kind).toBe("PASSWORD_RESET");
    expect(sent.to).toBe("ada@example.com");
    expect(sent.relatedId).toBe("user-1");
    expect(sent.subject).toBe("Reset your Attendly password");
    expect(sent.text).toContain("https://attendly.example.test/reset-password?token=tok%2Fen%2B1");
  });

  it("never logs the raw token", async () => {
    await sendPasswordResetEmail(user, "SECRET-RAW-TOKEN");

    const everything = JSON.stringify([
      (logger.info as unknown as jest.Mock).mock.calls,
      (logger.debug as unknown as jest.Mock).mock.calls,
      (logger.error as unknown as jest.Mock).mock.calls,
    ]);
    expect(everything).not.toContain("SECRET-RAW-TOKEN");
  });

  it("returns the send result and never throws when the send fails", async () => {
    mockedSend.mockResolvedValue({ ok: false, error: "Resend is down" });

    await expect(sendPasswordResetEmail(user, "tok")).resolves.toEqual({
      ok: false,
      error: "Resend is down",
    });
  });

  it("dead-letters the email, recording no token, when APP_BASE_URL is missing in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_BASE_URL;

    const result = await sendPasswordResetEmail(user, "SECRET-RAW-TOKEN");

    expect(result.ok).toBe(false);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(JSON.stringify(mockedRecord.mock.calls)).not.toContain("SECRET-RAW-TOKEN");
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "PASSWORD_RESET", to: "ada@example.com" }),
      expect.stringContaining("APP_BASE_URL"),
    );
  });
});
