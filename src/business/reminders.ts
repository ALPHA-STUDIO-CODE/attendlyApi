// Reminder scheduling logic (spec §7.5), kept pure so it can be tested
// without a clock, a database or an email provider.

/** Limits on a reminder offset, so a typo can't schedule one months away. */
export const MAX_REMINDER_HOURS_BEFORE = 720; // 30 days
export const MAX_REMINDER_CONFIGS_PER_EVENT = 5;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The instant a reminder becomes due. Both values are absolute UTC instants,
 * so "N hours before" means N elapsed hours: across a daylight-saving change
 * the local wall-clock time of the reminder can shift by an hour relative to
 * the previous day, and that is intended (spec §7.5, Event.timezone only
 * drives display).
 */
export function reminderDueAt(startTime: Date, hoursBefore: number): Date {
  return new Date(startTime.getTime() - hoursBefore * HOUR_MS);
}

/** `now >= startTime - hoursBefore hours`. */
export function isReminderDue(now: Date, startTime: Date, hoursBefore: number): boolean {
  return now.getTime() >= reminderDueAt(startTime, hoursBefore).getTime();
}

export type ReminderDecision = "not_due" | "send" | "skip";

/**
 * What the job should do with one unsent reminder:
 * - `not_due`: leave it for a later run;
 * - `send`: due, and the event is still open and hasn't started;
 * - `skip`: due, but the event has already started or isn't `PUBLISHED`
 *   (e.g. cancelled), so a reminder would be wrong — the job marks it sent
 *   without emailing anyone, so it doesn't linger.
 */
export function decideReminder(
  now: Date,
  event: { startTime: Date; status: string },
  hoursBefore: number,
): ReminderDecision {
  if (!isReminderDue(now, event.startTime, hoursBefore)) {
    return "not_due";
  }
  if (event.status !== "PUBLISHED" || now.getTime() >= event.startTime.getTime()) {
    return "skip";
  }
  return "send";
}
