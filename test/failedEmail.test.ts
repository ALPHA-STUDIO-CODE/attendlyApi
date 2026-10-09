import { sendEmail } from "../src/integrations/resend";
import { prisma } from "../src/db/prisma";

// Only the Resend SDK is mocked; the dead-letter row goes through the real
// database so this proves the migration, the model and the wrapper agree.
const mockSend = jest.fn();
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));

const ORIGINAL_ENV = { ...process.env };

function uniqueRecipient(): string {
  return `i1-${Date.now()}-${Math.random()}@example.com`;
}

function failedRowsFor(recipient: string) {
  return prisma.failedEmail.findMany({ where: { recipient } });
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Attendly <noreply@example.com>";
  mockSend.mockResolvedValue({ data: { id: "email_123" }, error: null });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("FailedEmail dead-letter table", () => {
  it("records exactly one row when Resend returns an API error", async () => {
    const to = uniqueRecipient();
    mockSend.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Invalid recipient" },
    });

    const result = await sendEmail({
      kind: "REGISTRATION_CONFIRMATION",
      to,
      subject: "You're registered",
      html: "<p>hi</p>",
      text: "hi",
      relatedId: "registration-123",
    });

    expect(result.ok).toBe(false);
    const rows = await failedRowsFor(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "REGISTRATION_CONFIRMATION",
      recipient: to,
      subject: "You're registered",
      errorMessage: "validation_error: Invalid recipient",
      relatedId: "registration-123",
    });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it("records exactly one row when the send throws", async () => {
    const to = uniqueRecipient();
    mockSend.mockRejectedValue(new Error("socket hang up"));

    const result = await sendEmail({
      kind: "EVENT_CANCELLATION",
      to,
      subject: "Event cancelled",
      html: "<p>sorry</p>",
      text: "sorry",
      relatedId: "event-456",
    });

    expect(result).toEqual({ ok: false, error: "socket hang up" });
    const rows = await failedRowsFor(to);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorMessage).toBe("socket hang up");
  });

  it("records nothing when the send succeeds", async () => {
    const to = uniqueRecipient();

    const result = await sendEmail({
      kind: "WAITLIST_PROMOTION",
      to,
      subject: "You're in",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(result).toEqual({ ok: true, id: "email_123" });
    expect(await failedRowsFor(to)).toHaveLength(0);
  });

  it("stores no email body — a reset token in the email never reaches the table", async () => {
    const to = uniqueRecipient();
    mockSend.mockRejectedValue(new Error("socket hang up"));

    await sendEmail({
      kind: "PASSWORD_RESET",
      to,
      subject: "Reset your password",
      html: "<a href='https://example.com/reset?token=SECRET-RESET-TOKEN'>Reset</a>",
      text: "https://example.com/reset?token=SECRET-RESET-TOKEN",
      relatedId: "user-789",
    });

    const [row] = await failedRowsFor(to);
    expect(Object.keys(row).sort()).toEqual(
      ["createdAt", "errorMessage", "id", "kind", "recipient", "relatedId", "subject"].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("SECRET-RESET-TOKEN");
  });

  it("leaves relatedId null when the caller gives none", async () => {
    const to = uniqueRecipient();
    mockSend.mockRejectedValue(new Error("socket hang up"));

    await sendEmail({ kind: "EVENT_REMINDER", to, subject: "Soon", html: "<p>x</p>", text: "x" });

    const [row] = await failedRowsFor(to);
    expect(row.relatedId).toBeNull();
  });
});
