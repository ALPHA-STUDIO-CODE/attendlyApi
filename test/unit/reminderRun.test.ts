import * as cron from "node-cron";
import { prisma } from "../../src/db/prisma";
import { sendEmail } from "../../src/integrations/resend";
import { logger } from "../../src/logger";
import {
  REMINDER_CRON_SCHEDULE,
  runReminderJob,
  shouldStartReminderJob,
  startReminderJob,
} from "../../src/jobs/reminderJob";

// The database, the email wrapper, the scheduler and the logger are mocked:
// these tests cover the job's own decisions — what it claims, whom it emails,
// and that nothing it does can throw, re-send or crash the process (spec §7.5).
jest.mock("../../src/db/prisma", () => ({
  prisma: { reminderConfig: { findMany: jest.fn() }, $transaction: jest.fn() },
}));
jest.mock("../../src/integrations/resend", () => ({
  sendEmail: jest.fn(),
  recordEmailFailure: jest.fn(),
}));
jest.mock("../../src/logger", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("node-cron", () => ({ schedule: jest.fn() }));

const mockedFindConfigs = prisma.reminderConfig.findMany as unknown as jest.Mock;
const mockedTransaction = prisma.$transaction as unknown as jest.Mock;
const mockedSend = sendEmail as unknown as jest.Mock;
const mockedSchedule = cron.schedule as unknown as jest.Mock;
const mockedWarn = logger.warn as unknown as jest.Mock;
const mockedError = logger.error as unknown as jest.Mock;

// The transaction's client: a claim (updateMany) and the recipient lookup.
const tx = {
  reminderConfig: { updateMany: jest.fn() },
  registration: { findMany: jest.fn() },
};

const ORIGINAL_ENV = { ...process.env };
const HOUR = 60 * 60 * 1000;

const EVENT = {
  id: "evt-1",
  title: "Tech Meetup",
  status: "PUBLISHED",
  startTime: new Date("2026-11-07T23:00:00.000Z"),
  endTime: new Date("2026-11-08T02:00:00.000Z"),
  timezone: "America/New_York",
  venueName: "Test Hall",
  address: "123 Test St",
  city: "Testville",
};
// Exactly 24 hours before the start: the reminder is due this instant.
const NOW = new Date("2026-11-06T23:00:00.000Z");

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    eventId: "evt-1",
    hoursBefore: 24,
    sent: false,
    event: EVENT,
    ...overrides,
  };
}

const RECIPIENTS = ["a", "b", "c"].map((letter) => ({
  id: `reg-${letter}`,
  user: { name: `User ${letter.toUpperCase()}`, email: `${letter}@example.com` },
}));

beforeEach(() => {
  process.env.APP_BASE_URL = "https://attendly.example.test";
  process.env.NODE_ENV = "test";
  delete process.env.REMINDER_JOB_ENABLED;
  mockedFindConfigs.mockResolvedValue([config()]);
  mockedTransaction.mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
  tx.reminderConfig.updateMany.mockResolvedValue({ count: 1 });
  tx.registration.findMany.mockResolvedValue(RECIPIENTS);
  mockedSend.mockResolvedValue({ ok: true, id: "email_1" });
});

afterEach(() => {
  jest.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("runReminderJob — a due reminder", () => {
  it("looks only at unsent reminders for events within the maximum offset", async () => {
    await runReminderJob({ now: NOW });

    expect(mockedFindConfigs).toHaveBeenCalledTimes(1);
    expect(mockedFindConfigs.mock.calls[0][0].where).toEqual({
      sent: false,
      event: { startTime: { lte: new Date(NOW.getTime() + 720 * HOUR) } },
    });
  });

  it("can be limited to one event", async () => {
    await runReminderJob({ now: NOW, eventId: "evt-1" });

    expect(mockedFindConfigs.mock.calls[0][0].where).toMatchObject({
      sent: false,
      eventId: "evt-1",
    });
  });

  it("claims the reminder, fetches REGISTERED attendees only, in the same transaction", async () => {
    await runReminderJob({ now: NOW });

    expect(mockedTransaction).toHaveBeenCalledTimes(1);
    expect(tx.reminderConfig.updateMany).toHaveBeenCalledWith({
      where: { id: "cfg-1", sent: false },
      data: { sent: true },
    });
    expect(tx.registration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "evt-1", status: "REGISTERED" } }),
    );
  });

  it("marks the reminder sent before sending anything (at most once)", async () => {
    await runReminderJob({ now: NOW });

    const claimedAt = tx.reminderConfig.updateMany.mock.invocationCallOrder[0];
    const firstSendAt = mockedSend.mock.invocationCallOrder[0];
    expect(claimedAt).toBeLessThan(firstSendAt);
  });

  it("emails every registered attendee a reminder with a per-recipient idempotency key", async () => {
    const summary = await runReminderJob({ now: NOW });

    expect(mockedSend.mock.calls.map(([sent]) => sent.to)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    const [first] = mockedSend.mock.calls[0];
    expect(first.kind).toBe("EVENT_REMINDER");
    expect(first.relatedId).toBe("reg-a");
    expect(first.idempotencyKey).toBe("event-reminder/cfg-1/reg-a");
    expect(first.subject).toBe("Reminder: Tech Meetup on Saturday, November 7, 2026");
    expect(summary).toEqual({
      checked: 1,
      due: 1,
      claimed: 1,
      skipped: 0,
      recipients: 3,
      sent: 3,
      failed: 0,
    });
  });

  it("words the email around the event's date, never 'in 24 hours'", async () => {
    await runReminderJob({ now: NOW });

    const [first] = mockedSend.mock.calls[0];
    expect(first.text).toContain("is coming up");
    expect(first.text).toContain("When: Saturday, November 7, 2026, 6:00 PM EST");
    expect(first.text).not.toContain("24 hours");
  });

  it("sends one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockedSend.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, id: "email_1" };
    });

    await runReminderJob({ now: NOW });

    expect(mockedSend).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});

describe("runReminderJob — reminders it leaves alone or retires", () => {
  it("leaves a reminder that isn't due yet untouched", async () => {
    const summary = await runReminderJob({ now: new Date(NOW.getTime() - 1) });

    expect(mockedTransaction).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ checked: 1, due: 0, claimed: 0 });
  });

  it("marks a due reminder sent without emailing once the event has started", async () => {
    const summary = await runReminderJob({ now: EVENT.startTime });

    expect(tx.reminderConfig.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.registration.findMany).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ due: 1, claimed: 1, skipped: 1, recipients: 0, sent: 0 });
  });

  it("marks a due reminder sent without emailing when the event was cancelled", async () => {
    mockedFindConfigs.mockResolvedValue([config({ event: { ...EVENT, status: "CANCELLED" } })]);

    const summary = await runReminderJob({ now: NOW });

    expect(tx.reminderConfig.updateMany).toHaveBeenCalledTimes(1);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ claimed: 1, skipped: 1, sent: 0 });
  });

  it("does nothing when another run or instance already claimed the reminder", async () => {
    tx.reminderConfig.updateMany.mockResolvedValue({ count: 0 });

    const summary = await runReminderJob({ now: NOW });

    expect(tx.registration.findMany).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ due: 1, claimed: 0, sent: 0 });
  });
});

describe("runReminderJob — failures never cause a re-send", () => {
  it("counts a failed send, carries on with the rest, and never un-sends the reminder", async () => {
    let call = 0;
    mockedSend.mockImplementation(async () => {
      call += 1;
      return call === 2 ? { ok: false, error: "bounced" } : { ok: true, id: "email_1" };
    });

    const summary = await runReminderJob({ now: NOW });

    expect(mockedSend).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ recipients: 3, sent: 2, failed: 1 });
    expect(tx.reminderConfig.updateMany).toHaveBeenCalledTimes(1);
  });

  it("survives a send that throws mid-run, and the next run does not re-send", async () => {
    let call = 0;
    mockedSend.mockImplementation(async () => {
      call += 1;
      if (call === 2) {
        throw new Error("process fell over");
      }
      return { ok: true, id: "email_1" };
    });

    const first = await runReminderJob({ now: NOW });
    expect(first).toMatchObject({ sent: 2, failed: 1 });
    expect(mockedSend).toHaveBeenCalledTimes(3);

    // The database now holds sent=true, so the next run can't claim it.
    tx.reminderConfig.updateMany.mockResolvedValue({ count: 0 });
    const second = await runReminderJob({ now: new Date(NOW.getTime() + 5 * 60 * 1000) });

    expect(second).toMatchObject({ claimed: 0, sent: 0 });
    expect(mockedSend).toHaveBeenCalledTimes(3);
  });

  it("keeps going with other reminders when one fails to be processed", async () => {
    mockedFindConfigs.mockResolvedValue([config({ id: "cfg-1" }), config({ id: "cfg-2" })]);
    mockedTransaction
      .mockImplementationOnce(() => Promise.reject(new Error("database hiccup")))
      .mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));

    const summary = await runReminderJob({ now: NOW });

    expect(mockedError).toHaveBeenCalledWith(
      expect.objectContaining({ reminderConfigId: "cfg-1", error: "database hiccup" }),
      "Reminder processing failed",
    );
    expect(summary).toMatchObject({ due: 2, claimed: 1, sent: 3 });
  });

  it("never rejects when it can't even load the reminders", async () => {
    mockedFindConfigs.mockRejectedValue(new Error("database is down"));

    const summary = await runReminderJob({ now: NOW });

    expect(summary).toMatchObject({ checked: 0, due: 0, sent: 0 });
    expect(mockedError).toHaveBeenCalledWith(
      expect.objectContaining({ error: "database is down" }),
      "Reminder run aborted",
    );
  });
});

describe("shouldStartReminderJob", () => {
  it.each([
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "test" }, false],
    [{}, false],
    [{ NODE_ENV: "development", REMINDER_JOB_ENABLED: "true" }, true],
    [{ NODE_ENV: "production", REMINDER_JOB_ENABLED: "false" }, false],
    [{ NODE_ENV: "production", REMINDER_JOB_ENABLED: "yes" }, true],
    [{ NODE_ENV: "development", REMINDER_JOB_ENABLED: "yes" }, false],
  ])("for %p returns %p", (env, expected) => {
    expect(shouldStartReminderJob(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("startReminderJob", () => {
  it("does not schedule anything when it is switched off", () => {
    const task = startReminderJob();

    expect(task).toBe(null);
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  describe("when enabled", () => {
    beforeEach(() => {
      process.env.REMINDER_JOB_ENABLED = "true";
      mockedSchedule.mockReturnValue({ stop: jest.fn() });
      mockedFindConfigs.mockResolvedValue([]);
    });

    it("schedules a run every 5 minutes and returns the task", () => {
      const task = startReminderJob();

      expect(REMINDER_CRON_SCHEDULE).toBe("*/5 * * * *");
      expect(mockedSchedule).toHaveBeenCalledWith("*/5 * * * *", expect.anything());
      expect(task).not.toBe(null);
    });

    it("also runs once shortly after boot, not immediately", async () => {
      jest.useFakeTimers();
      startReminderJob();
      expect(mockedFindConfigs).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(10_000);

      expect(mockedFindConfigs).toHaveBeenCalledTimes(1);
    });

    it("runs the job on every scheduled tick", async () => {
      startReminderJob();
      const tick = mockedSchedule.mock.calls[0][1] as () => void;

      tick();
      await new Promise((resolve) => setImmediate(resolve));
      tick();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockedFindConfigs).toHaveBeenCalledTimes(2);
    });

    it("skips a tick while the previous run is still going, rather than piling up", async () => {
      let finishFirstRun: (configs: unknown[]) => void = () => {};
      mockedFindConfigs.mockReturnValueOnce(
        new Promise<unknown[]>((resolve) => {
          finishFirstRun = resolve;
        }),
      );
      startReminderJob();
      const tick = mockedSchedule.mock.calls[0][1] as () => void;

      tick();
      await new Promise((resolve) => setImmediate(resolve));
      tick();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockedFindConfigs).toHaveBeenCalledTimes(1);
      expect(mockedWarn).toHaveBeenCalledWith(
        { trigger: "schedule" },
        "Reminder run skipped: the previous run is still going",
      );

      finishFirstRun([]);
      await new Promise((resolve) => setImmediate(resolve));
      tick();
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockedFindConfigs).toHaveBeenCalledTimes(2);
    });
  });
});
