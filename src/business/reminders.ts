export const MAX_REMINDER_HOURS_BEFORE = 720; // 30 days
export const MAX_REMINDER_CONFIGS_PER_EVENT = 5;

const HOUR_MS = 60 * 60 * 1000;

export function reminderDueAt(startTime: Date, hoursBefore: number): Date {
  return new Date(startTime.getTime() - hoursBefore * HOUR_MS);
}

export function isReminderDue(now: Date, startTime: Date, hoursBefore: number): boolean {
  return now.getTime() >= reminderDueAt(startTime, hoursBefore).getTime();
}

export type ReminderDecision = "not_due" | "send" | "skip";

export function decideReminder(
  now: Date,
  event: { startTime: Date; status: string; deletedAt?: Date | null },
  hoursBefore: number,
): ReminderDecision {
  if (!isReminderDue(now, event.startTime, hoursBefore)) {
    return "not_due";
  }
  if (
    event.status !== "PUBLISHED" ||
    event.deletedAt ||
    now.getTime() >= event.startTime.getTime()
  ) {
    return "skip";
  }
  return "send";
}
