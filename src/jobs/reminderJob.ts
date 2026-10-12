import * as cron from "node-cron";
import { prisma } from "../db/prisma";
import { EVENT_LOCK_TX_OPTIONS } from "../db/transactionOptions";
import { logger } from "../logger";
import { MAX_REMINDER_HOURS_BEFORE, decideReminder } from "../business/reminders";
import { deliver } from "../email/deliver";
import { eventReminderEmail } from "../email/templates";

// Reminder emails (spec §7.5): a scheduled job in the API process (v1) that
// finds due `ReminderConfig` rows and emails the event's registered
// attendees. Run by `server.ts`, never by `app.ts`, so tests don't start a
// timer; tests call `runReminderJob` directly.
//
// At most once, by design: a reminder is claimed — flipped to sent — in the
// same transaction that fetches its recipients, *before* any email goes out.
// A crash mid-send therefore loses the remaining recipients rather than
// re-sending to the ones already emailed; individual send failures are
// dead-lettered by the email wrapper for manual retry, and `sent` is never
// flipped back.

export const REMINDER_CRON_SCHEDULE = "*/5 * * * *";
const STARTUP_DELAY_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

export interface ReminderRunOptions {
  now?: Date;
  /** Limit the run to one event (used by tests, so they don't touch each other's data). */
  eventId?: string;
}

export interface ReminderRunSummary {
  /** Unsent reminders looked at. */
  checked: number;
  /** Of those, how many were due. */
  due: number;
  /** Due reminders this run claimed (another run may have claimed the rest). */
  claimed: number;
  /** Claimed reminders marked sent without emailing (event started or not open). */
  skipped: number;
  recipients: number;
  sent: number;
  failed: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DueReminder = Awaited<ReturnType<typeof findCandidates>>[number];

function findCandidates(now: Date, eventId?: string) {
  return prisma.reminderConfig.findMany({
    where: {
      sent: false,
      ...(eventId ? { eventId } : {}),
      // Offsets are capped, so an event further out than that can't have a
      // due reminder yet. Events already in the past stay in the result on
      // purpose, so their stale reminders get cleaned up once.
      event: { startTime: { lte: new Date(now.getTime() + MAX_REMINDER_HOURS_BEFORE * HOUR_MS) } },
    },
    include: { event: true },
    orderBy: [{ event: { startTime: "asc" } }, { id: "asc" }],
  });
}

async function processDueReminder(
  config: DueReminder,
  decision: "send" | "skip",
  summary: ReminderRunSummary,
): Promise<void> {
  const claim = await prisma.$transaction(async (tx) => {
    const claimed = await tx.reminderConfig.updateMany({
      where: { id: config.id, sent: false },
      data: { sent: true },
    });
    if (claimed.count === 0) {
      return null; // an overlapping run or another instance got there first
    }
    if (decision === "skip") {
      return { recipients: [] };
    }
    const recipients = await tx.registration.findMany({
      where: { eventId: config.eventId, status: "REGISTERED" },
      orderBy: { createdAt: "asc" },
      select: { id: true, user: { select: { name: true, email: true } } },
    });
    return { recipients };
  }, EVENT_LOCK_TX_OPTIONS);

  if (!claim) {
    return;
  }
  summary.claimed += 1;

  if (decision === "skip") {
    summary.skipped += 1;
    logger.info(
      {
        reminderConfigId: config.id,
        eventId: config.eventId,
        reason: config.event.status !== "PUBLISHED" ? "event_not_published" : "event_started",
      },
      "Reminder marked sent without emailing: the event is no longer upcoming",
    );
    return;
  }

  summary.recipients += claim.recipients.length;
  for (const recipient of claim.recipients) {
    try {
      const result = await deliver({
        kind: "EVENT_REMINDER",
        to: recipient.user.email,
        relatedId: recipient.id,
        // Each reminder is claimed exactly once, so this key can never block a
        // legitimate send; it only guards a hypothetical repeat of this one.
        idempotencyKey: `event-reminder/${config.id}/${recipient.id}`,
        build: () => eventReminderEmail({ userName: recipient.user.name, event: config.event }),
      });
      if (result.ok) {
        summary.sent += 1;
      } else {
        summary.failed += 1;
      }
    } catch (error) {
      // `deliver` never rejects, but a reminder run must survive anything: the
      // reminder is already marked sent, so there is no retry to fall back on.
      summary.failed += 1;
      logger.error(
        {
          reminderConfigId: config.id,
          registrationId: recipient.id,
          error: describeError(error),
        },
        "Reminder email failed unexpectedly",
      );
    }
  }
}

/**
 * One pass over the unsent reminders. Never rejects: one reminder failing must
 * not stop the others, and an exception must not crash the scheduler.
 */
export async function runReminderJob(
  options: ReminderRunOptions = {},
): Promise<ReminderRunSummary> {
  const now = options.now ?? new Date();
  const summary: ReminderRunSummary = {
    checked: 0,
    due: 0,
    claimed: 0,
    skipped: 0,
    recipients: 0,
    sent: 0,
    failed: 0,
  };

  try {
    const candidates = await findCandidates(now, options.eventId);
    summary.checked = candidates.length;

    for (const config of candidates) {
      const decision = decideReminder(now, config.event, config.hoursBefore);
      if (decision === "not_due") {
        continue;
      }
      summary.due += 1;
      try {
        await processDueReminder(config, decision, summary);
      } catch (error) {
        logger.error(
          {
            reminderConfigId: config.id,
            eventId: config.eventId,
            error: describeError(error),
          },
          "Reminder processing failed",
        );
      }
    }

    if (summary.due > 0) {
      logger.info({ ...summary }, "Reminder run finished");
    }
  } catch (error) {
    logger.error({ error: describeError(error), ...summary }, "Reminder run aborted");
  }
  return summary;
}

/**
 * The scheduler only runs in production unless told otherwise. A local server
 * pointed at a shared database has no Resend key, so it would still mark real
 * reminders as sent while merely logging them — and the real attendees would
 * never get them.
 */
export function shouldStartReminderJob(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.REMINDER_JOB_ENABLED === "true") {
    return true;
  }
  if (env.REMINDER_JOB_ENABLED === "false") {
    return false;
  }
  return env.NODE_ENV === "production";
}

/** Starts the every-5-minutes schedule (plus a run shortly after boot). */
export function startReminderJob(): ReturnType<typeof cron.schedule> | null {
  if (!shouldStartReminderJob()) {
    logger.info(
      "Reminder job not started (production only; set REMINDER_JOB_ENABLED=true to force)",
    );
    return null;
  }

  // A run slower than the interval must not pile up behind itself.
  let running = false;
  const tick = async (trigger: "schedule" | "startup"): Promise<void> => {
    if (running) {
      logger.warn({ trigger }, "Reminder run skipped: the previous run is still going");
      return;
    }
    running = true;
    try {
      await runReminderJob();
    } catch (error) {
      logger.error({ error: describeError(error) }, "Reminder run crashed");
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(REMINDER_CRON_SCHEDULE, () => {
    void tick("schedule");
  });
  // Catch up shortly after a deploy instead of waiting for the next slot.
  setTimeout(() => {
    void tick("startup");
  }, STARTUP_DELAY_MS).unref();

  logger.info({ schedule: REMINDER_CRON_SCHEDULE }, "Reminder job started");
  return task;
}
