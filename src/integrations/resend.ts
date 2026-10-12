import { Resend } from "resend";
import { prisma } from "../db/prisma";
import { logger } from "../logger";

export type EmailKind =
  | "REGISTRATION_CONFIRMATION"
  | "WAITLIST_JOINED"
  | "WAITLIST_PROMOTION"
  | "EVENT_CANCELLATION"
  | "PASSWORD_RESET"
  | "EVENT_REMINDER";

export interface SendEmailInput {
  kind: EmailKind;
  to: string;
  subject: string;
  html: string;
  text: string;
  relatedId?: string;
  idempotencyKey?: string;
}

export type SendEmailResult = { ok: true; id: string | null } | { ok: false; error: string };

const SEND_TIMEOUT_MS = 5_000;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type EmailFailureInput = Pick<SendEmailInput, "kind" | "to" | "subject" | "relatedId">;

export async function recordEmailFailure(
  input: EmailFailureInput,
  error: string,
): Promise<SendEmailResult> {
  logger.error(
    { kind: input.kind, to: input.to, relatedId: input.relatedId, error },
    "Email send failed; recording in dead-letter table",
  );
  try {
    await prisma.failedEmail.create({
      data: {
        kind: input.kind,
        recipient: input.to,
        subject: input.subject,
        errorMessage: error,
        relatedId: input.relatedId,
      },
    });
  } catch (writeError) {
    logger.error(
      {
        kind: input.kind,
        to: input.to,
        relatedId: input.relatedId,
        error: describeError(writeError),
      },
      "Could not write FailedEmail row; the log line above is the only record",
    );
  }
  return { ok: false, error };
}

async function attemptSend(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey && process.env.NODE_ENV !== "production") {
    logger.info(
      { kind: input.kind, to: input.to, subject: input.subject, relatedId: input.relatedId },
      "[dev] RESEND_API_KEY is not set; email logged instead of sent",
    );
    logger.debug({ to: input.to, text: input.text }, "[dev] Email body");
    return { ok: true, id: null };
  }

  if (!apiKey || !from) {
    throw new Error("Resend is not configured: set RESEND_API_KEY and EMAIL_FROM.");
  }

  const resend = new Resend(apiKey);
  const { data, error } = await withTimeout(
    resend.emails.send(
      {
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      },
      input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
    ),
    SEND_TIMEOUT_MS,
  );

  if (error) {
    return recordEmailFailure(
      input,
      `${error.name}: ${error.message}`.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    );
  }
  if (!data) {
    return recordEmailFailure(input, "Resend returned neither data nor an error.");
  }
  return { ok: true, id: data.id };
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  try {
    return await attemptSend(input);
  } catch (error) {
    return recordEmailFailure(input, describeError(error));
  }
}
