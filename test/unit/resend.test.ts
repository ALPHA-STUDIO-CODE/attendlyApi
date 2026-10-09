import { Resend } from "resend";
import { sendEmail, type SendEmailInput } from "../../src/integrations/resend";
import { prisma } from "../../src/db/prisma";
import { logger } from "../../src/logger";

// The SDK, the database and the logger are all mocked: this file only tests
// the wrapper's own behaviour (spec §8.5 — a failed send is caught, logged
// and dead-lettered, and never throws).
const mockSend = jest.fn();
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));
jest.mock("../../src/db/prisma", () => ({
  prisma: { failedEmail: { create: jest.fn() } },
}));
jest.mock("../../src/logger", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const MockedResend = Resend as unknown as jest.Mock;
const mockedCreate = prisma.failedEmail.create as unknown as jest.Mock;
const mockedLoggerError = logger.error as unknown as jest.Mock;
const mockedLoggerInfo = logger.info as unknown as jest.Mock;

const INPUT: SendEmailInput = {
  kind: "PASSWORD_RESET",
  to: "ada@example.com",
  subject: "Reset your password",
  html: "<p>SECRET-HTML-TOKEN-abc123</p>",
  text: "SECRET-TEXT-TOKEN-abc123",
  relatedId: "user-1",
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Attendly <noreply@example.com>";
  process.env.NODE_ENV = "test";
  mockSend.mockResolvedValue({ data: { id: "email_123" }, error: null });
  mockedCreate.mockResolvedValue({});
});

afterEach(() => {
  jest.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("sendEmail — success", () => {
  it("resolves with the Resend email id", async () => {
    const result = await sendEmail(INPUT);

    expect(result).toEqual({ ok: true, id: "email_123" });
  });

  it("sends the right payload using the configured API key and sender", async () => {
    await sendEmail(INPUT);

    expect(MockedResend).toHaveBeenCalledWith("re_test_key");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      {
        from: "Attendly <noreply@example.com>",
        to: "ada@example.com",
        subject: "Reset your password",
        html: INPUT.html,
        text: INPUT.text,
      },
      undefined,
    );
  });

  it("does not write a dead-letter row", async () => {
    await sendEmail(INPUT);

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedLoggerError).not.toHaveBeenCalled();
  });

  it("passes an idempotency key through to Resend when one is given", async () => {
    await sendEmail({ ...INPUT, idempotencyKey: "registration-confirmation/reg-1" });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }), {
      idempotencyKey: "registration-confirmation/reg-1",
    });
  });
});

describe("sendEmail — failure never throws", () => {
  it("handles an API error returned by the SDK: resolves ok:false and dead-letters it", async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Invalid recipient" },
    });

    const result = await sendEmail(INPUT);

    expect(result).toEqual({ ok: false, error: "validation_error: Invalid recipient" });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("handles an exception thrown by the SDK (e.g. a network error)", async () => {
    mockSend.mockRejectedValue(new Error("socket hang up"));

    const result = await sendEmail(INPUT);

    expect(result).toEqual({ ok: false, error: "socket hang up" });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("handles a response with neither data nor an error", async () => {
    mockSend.mockResolvedValue({ data: null, error: null });

    const result = await sendEmail(INPUT);

    expect(result).toEqual({ ok: false, error: "Resend returned neither data nor an error." });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("gives up after 5 seconds instead of hanging the caller", async () => {
    jest.useFakeTimers();
    mockSend.mockReturnValue(new Promise(() => {})); // never settles

    const pending = sendEmail(INPUT);
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result).toEqual({ ok: false, error: "Timed out after 5000ms" });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("still resolves when the dead-letter write itself fails, and logs both problems", async () => {
    mockSend.mockRejectedValue(new Error("socket hang up"));
    mockedCreate.mockRejectedValue(new Error("database is down"));

    const result = await sendEmail(INPUT);

    expect(result).toEqual({ ok: false, error: "socket hang up" });
    expect(mockedLoggerError).toHaveBeenCalledTimes(2);
  });

  it("truncates very long error messages", async () => {
    mockSend.mockRejectedValue(new Error("x".repeat(5_000)));

    const result = await sendEmail(INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toHaveLength(1_000);
    }
  });
});

describe("sendEmail — dead-letter record", () => {
  it("stores only metadata: kind, recipient, subject, error and related id", async () => {
    mockSend.mockRejectedValue(new Error("socket hang up"));

    await sendEmail(INPUT);

    expect(mockedCreate).toHaveBeenCalledWith({
      data: {
        kind: "PASSWORD_RESET",
        recipient: "ada@example.com",
        subject: "Reset your password",
        errorMessage: "socket hang up",
        relatedId: "user-1",
      },
    });
  });

  it("never stores or logs the email body (it can contain a raw reset token)", async () => {
    mockSend.mockRejectedValue(new Error("socket hang up"));

    await sendEmail(INPUT);

    expect(JSON.stringify(mockedCreate.mock.calls)).not.toContain("SECRET");
    expect(JSON.stringify(mockedLoggerError.mock.calls)).not.toContain("SECRET");
  });

  it("logs the failure before writing the row, so a trace survives a database outage", async () => {
    mockSend.mockRejectedValue(new Error("socket hang up"));

    await sendEmail(INPUT);

    expect(mockedLoggerError.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCreate.mock.invocationCallOrder[0],
    );
  });
});

describe("sendEmail — configuration", () => {
  it.each(["development", "test"])(
    "logs instead of sending when RESEND_API_KEY is unset (NODE_ENV=%s)",
    async (nodeEnv) => {
      delete process.env.RESEND_API_KEY;
      process.env.NODE_ENV = nodeEnv;

      const result = await sendEmail(INPUT);

      expect(result).toEqual({ ok: true, id: null });
      expect(MockedResend).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockedCreate).not.toHaveBeenCalled();
      expect(mockedLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "PASSWORD_RESET", to: "ada@example.com" }),
        expect.stringContaining("logged instead of sent"),
      );
    },
  );

  it("treats a missing RESEND_API_KEY in production as a failed send, not a silent skip", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.NODE_ENV = "production";

    const result = await sendEmail(INPUT);

    expect(result).toEqual({
      ok: false,
      error: "Resend is not configured: set RESEND_API_KEY and EMAIL_FROM.",
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("treats a missing EMAIL_FROM as a failed send when a key is set", async () => {
    delete process.env.EMAIL_FROM;

    const result = await sendEmail(INPUT);

    expect(result).toEqual({
      ok: false,
      error: "Resend is not configured: set RESEND_API_KEY and EMAIL_FROM.",
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});
