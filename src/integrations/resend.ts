import { Resend } from "resend";
import { prisma } from "../db/prisma";
import { logger } from "../logger";

// Thin wrapper around the Resend SDK. Routes and jobs depend on this module,
// not on the SDK, so tests can mock one function (spec §12: never hit real
// third-party APIs in tests) and the SDK stays swappable.
//
// Spec §8.5: an email failure must never block the action that triggered it.
// So `sendEmail` never throws and never rejects — it always resolves with a
// result the caller can inspect (e.g. to add a `warnings` entry to a
// response). Failures are logged and recorded in the `FailedEmail`
// dead-letter table.

export type EmailKind =
  | "REGISTRATION_CONFIRMATION"
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
  /**
   * Id of the record this email is about (registration, event, user...), so a
   * failed send can be traced back and re-queued from our own data.
   */
  relatedId?: string;
  /**
   * Resend de-duplicates sends that share a key for 24 hours, which makes a
   * later retry safe from duplicate emails.
   */
  idempotencyKey?: string;
}

export type SendEmailResult = { ok: true; id: string | null } | { ok: false; error: string };

// A hung Resend call must not hang the request that triggered the email.
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

/**
 * Records a failed send: the log line comes first so there is still a trace
 * if the database write itself fails. Deliberately stores no email body —
 * password-reset emails contain the raw reset token, which must never sit at
 * rest — so a retry re-renders from `kind` + `relatedId` instead. Never
 * throws.
 */
async function recordFailure(input: SendEmailInput, error: string): Promise<SendEmailResult> {
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
    // Local development and tests without a key: show the email instead of
    // sending it, so flows like password reset can still be exercised by
    // hand. Never reached in production, where a missing key is a failure.
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
  // The SDK reports API errors in the returned `error` rather than throwing;
  // network-level failures can still throw. Both are handled.
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
    return recordFailure(
      input,
      `${error.name}: ${error.message}`.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    );
  }
  if (!data) {
    return recordFailure(input, "Resend returned neither data nor an error.");
  }
  return { ok: true, id: data.id };
}

/**
 * Sends one email. Never throws: resolves `{ ok: true, id }` on success (`id`
 * is null when the dev log-only transport was used) or `{ ok: false, error }`
 * after logging the failure and recording it in `FailedEmail`.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  try {
    return await attemptSend(input);
  } catch (error) {
    return recordFailure(input, describeError(error));
  }
}
