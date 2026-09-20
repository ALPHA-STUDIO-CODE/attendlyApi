const LOCKED_FIELDS = [
  "date",
  "startTime",
  "endTime",
  "venueName",
  "address",
  "city",
  "maxCapacity",
  "timezone",
] as const;

export type LockedField = (typeof LOCKED_FIELDS)[number];

export function getRejectedLockedFields(changedFields: string[], isLocked: boolean): string[] {
  if (!isLocked) {
    return [];
  }
  return changedFields.filter((field): field is LockedField =>
    (LOCKED_FIELDS as readonly string[]).includes(field),
  );
}
