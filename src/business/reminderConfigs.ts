import type { Prisma } from "@prisma/client";

/**
 * How reminder configs appear in event responses: just the offset, newest
 * (largest) first. The `sent` flag and row ids are internal bookkeeping for
 * the reminder job and are never exposed.
 */
export const REMINDER_CONFIGS_INCLUDE = {
  select: { hoursBefore: true },
  orderBy: { hoursBefore: "desc" },
} as const;

export interface ExistingReminderConfig {
  id: string;
  hoursBefore: number;
}

/**
 * Works out the minimal change from the existing reminders to the desired
 * offsets. Rows whose offset is still wanted are kept untouched — crucially
 * with their `sent` flag, so re-saving an unchanged set (as an edit form
 * does) can't re-arm a reminder that already went out.
 */
export function diffReminderConfigs(
  existing: ExistingReminderConfig[],
  desiredHours: number[],
): { deleteIds: string[]; createHours: number[] } {
  const desired = new Set(desiredHours);
  const keptHours = new Set(
    existing.filter((config) => desired.has(config.hoursBefore)).map((c) => c.hoursBefore),
  );
  return {
    deleteIds: existing.filter((config) => !desired.has(config.hoursBefore)).map((c) => c.id),
    createHours: desiredHours.filter((hours) => !keptHours.has(hours)),
  };
}

/** Replaces an event's reminders with the desired offsets, keeping unchanged rows. */
export async function replaceReminderConfigs(
  tx: Prisma.TransactionClient,
  eventId: string,
  desiredHours: number[],
): Promise<void> {
  const existing = await tx.reminderConfig.findMany({
    where: { eventId },
    select: { id: true, hoursBefore: true },
  });
  const { deleteIds, createHours } = diffReminderConfigs(existing, desiredHours);

  if (deleteIds.length > 0) {
    await tx.reminderConfig.deleteMany({ where: { id: { in: deleteIds } } });
  }
  if (createHours.length > 0) {
    await tx.reminderConfig.createMany({
      data: createHours.map((hoursBefore) => ({ eventId, hoursBefore })),
    });
  }
}
