export interface EventSemanticInput {
  date?: string;
  startTime?: string;
  endTime?: string;
  maxCapacity?: number;
  timezone?: string;
}

export function getEventSemanticErrors(input: EventSemanticInput): Record<string, string> {
  const errors: Record<string, string> = {};

  if (input.startTime !== undefined && input.endTime !== undefined) {
    if (new Date(input.endTime).getTime() <= new Date(input.startTime).getTime()) {
      errors.endTime = "endTime must be after startTime.";
    }
  }

  if (input.maxCapacity !== undefined && input.maxCapacity <= 0) {
    errors.maxCapacity = "maxCapacity must be greater than 0.";
  }

  if (input.date !== undefined && new Date(input.date).getTime() < Date.now()) {
    errors.date = "date must not be in the past.";
  }

  if (input.timezone !== undefined && !isValidIanaTimezone(input.timezone)) {
    errors.timezone = "timezone must be a valid IANA timezone identifier (e.g. America/New_York).";
  }

  return errors;
}

function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
