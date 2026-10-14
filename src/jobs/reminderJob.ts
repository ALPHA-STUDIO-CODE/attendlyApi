import * as cron from "node-cron";
import { prisma } from "../db/prisma";
import { EVENT_LOCK_TX_OPTIONS } from "../db/transactionOptions";
import { logger } from "../logger";
import { MAX_REMINDER_HOURS_BEFORE, decideReminder } from "../business/reminders";
import { deliver } from "../email/deliver";
import { eventReminderEmail } from "../email/templates";

export const REMINDER_CRON_SCHEDULE = "*/5 * * * *";
const STARTUP_DELAY_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

export interface ReminderRunOptions {
  now?: Date;
  eventId?: string;
}

export interface ReminderRunSummary {
  checked: number;
  due: number;
  claimed: number;
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
        reason:
          config.event.status !== "PUBLISHED" || config.event.deletedAt
            ? "event_not_open"
            : "event_started",
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
        idempotencyKey: `event-reminder/${config.id}/${recipient.id}`,
        build: () => eventReminderEmail({ userName: recipient.user.name, event: config.event }),
      });
      if (result.ok) {
        summary.sent += 1;
      } else {
        summary.failed += 1;
      }
    } catch (error) {
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

export function shouldStartReminderJob(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.REMINDER_JOB_ENABLED === "true") {
    return true;
  }
  if (env.REMINDER_JOB_ENABLED === "false") {
    return false;
  }
  return env.NODE_ENV === "production";
}

export function startReminderJob(): ReturnType<typeof cron.schedule> | null {
  if (!shouldStartReminderJob()) {
    logger.info(
      "Reminder job not started (production only; set REMINDER_JOB_ENABLED=true to force)",
    );
    return null;
  }

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
  setTimeout(() => {
    void tick("startup");
  }, STARTUP_DELAY_MS).unref();

  logger.info({ schedule: REMINDER_CRON_SCHEDULE }, "Reminder job started");
  return task;
}
