import {
  MAX_REMINDER_CONFIGS_PER_EVENT,
  MAX_REMINDER_HOURS_BEFORE,
  decideReminder,
  isReminderDue,
  reminderDueAt,
} from "../../src/business/reminders";

const HOUR = 60 * 60 * 1000;

// 23:00Z on 7 Nov 2026 (6:00 PM in New York).
const START = new Date("2026-11-07T23:00:00.000Z");

describe("isReminderDue", () => {
  it("is due exactly at the threshold", () => {
    const threshold = new Date("2026-11-06T23:00:00.000Z"); // 24h before

    expect(isReminderDue(threshold, START, 24)).toBe(true);
  });

  it("is not due one millisecond before the threshold", () => {
    const justBefore = new Date("2026-11-06T22:59:59.999Z");

    expect(isReminderDue(justBefore, START, 24)).toBe(false);
  });

  it("is not yet due well ahead of the threshold", () => {
    expect(isReminderDue(new Date("2026-11-01T00:00:00.000Z"), START, 24)).toBe(false);
  });

  it("stays due once the threshold has passed, even after the event has started", () => {
    expect(isReminderDue(new Date("2026-11-07T00:00:00.000Z"), START, 24)).toBe(true);
    expect(isReminderDue(new Date("2026-11-09T00:00:00.000Z"), START, 24)).toBe(true);
  });

  it("works for other offsets", () => {
    expect(isReminderDue(new Date(START.getTime() - HOUR), START, 1)).toBe(true);
    expect(isReminderDue(new Date(START.getTime() - HOUR - 1), START, 1)).toBe(false);
  });
});

describe("reminderDueAt — daylight-saving changes", () => {
  it("counts elapsed hours across the spring-forward change (New York, 8 Mar 2026)", () => {
    // The event starts at 10:00 AM EDT on 8 Mar, after clocks jumped forward
    // at 2:00 AM. 24 elapsed hours earlier is 9:00 AM EST on 7 Mar — not the
    // "same wall-clock time yesterday", which would be 10:00 AM EST (15:00Z).
    const start = new Date("2026-03-08T14:00:00.000Z");

    expect(reminderDueAt(start, 24).toISOString()).toBe("2026-03-07T14:00:00.000Z");
  });

  it("counts elapsed hours across the fall-back change (New York, 1 Nov 2026)", () => {
    // The event starts at 10:00 AM EST on 1 Nov, after clocks fell back at
    // 2:00 AM. 24 elapsed hours earlier is 11:00 AM EDT on 31 Oct — not 10:00
    // AM EDT (14:00Z).
    const start = new Date("2026-11-01T15:00:00.000Z");

    expect(reminderDueAt(start, 24).toISOString()).toBe("2026-10-31T15:00:00.000Z");
  });

  it("decides due-ness by the UTC instant on either side of a clock change", () => {
    const start = new Date("2026-03-08T14:00:00.000Z");
    const due = new Date("2026-03-07T14:00:00.000Z");

    expect(isReminderDue(new Date(due.getTime() - 1), start, 24)).toBe(false);
    expect(isReminderDue(due, start, 24)).toBe(true);
  });
});

describe("decideReminder", () => {
  const open = { startTime: START, status: "PUBLISHED" };
  const dueNow = new Date("2026-11-06T23:00:00.000Z");

  it("says not_due before the threshold", () => {
    expect(decideReminder(new Date(dueNow.getTime() - 1), open, 24)).toBe("not_due");
  });

  it("says send when due, the event is open and hasn't started", () => {
    expect(decideReminder(dueNow, open, 24)).toBe("send");
    expect(decideReminder(new Date(START.getTime() - 1), open, 24)).toBe("send");
  });

  it("says skip once the event has started (a late reminder would be wrong)", () => {
    expect(decideReminder(START, open, 24)).toBe("skip");
    expect(decideReminder(new Date(START.getTime() + 5 * HOUR), open, 24)).toBe("skip");
  });

  it.each(["CANCELLED", "FLAGGED"])("says skip for a %s event once due", (status) => {
    expect(decideReminder(dueNow, { startTime: START, status }, 24)).toBe("skip");
  });

  it("leaves a not-yet-due reminder alone even if the event is cancelled", () => {
    const early = new Date(dueNow.getTime() - HOUR);

    expect(decideReminder(early, { startTime: START, status: "CANCELLED" }, 24)).toBe("not_due");
  });
});

describe("limits", () => {
  it("allows offsets up to 30 days and five reminders per event", () => {
    expect(MAX_REMINDER_HOURS_BEFORE).toBe(720);
    expect(MAX_REMINDER_CONFIGS_PER_EVENT).toBe(5);
  });
});
