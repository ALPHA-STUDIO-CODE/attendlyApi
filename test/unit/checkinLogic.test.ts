import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { signTicketToken } from "../../src/auth/ticketToken";
import {
  CHECKIN_GRACE_MS,
  checkInAttendee,
  getCheckInStats,
  type CheckInEvent,
} from "../../src/business/checkin";
import { AppError } from "../../src/errors";
import { logger } from "../../src/logger";

// Only the logger is mocked. The database is a hand-rolled stand-in passed in
// as `db`, and tokens are real signed JWTs, so these tests exercise the
// actual decision logic (spec §7.4, §8.5).
jest.mock("../../src/logger", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockedWarn = logger.warn as unknown as jest.Mock;

const db = {
  registration: { updateMany: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
};
const asDb = db as unknown as Prisma.TransactionClient;

const ORIGINAL_ENV = { ...process.env };

// Needed before TOKEN below is signed, i.e. at collection time, earlier than
// any beforeEach (which re-sets it after each test restores the environment).
process.env.JWT_TICKET_SECRET = "test-ticket-secret";

const EVENT: CheckInEvent = {
  id: "evt-1",
  status: "PUBLISHED",
  endTime: new Date("2026-11-08T02:00:00.000Z"),
};
const DURING = new Date("2026-11-07T23:30:00.000Z");
const TOKEN = signTicketToken({ registrationId: "reg-1", eventId: "evt-1" });

function stored(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "evt-1",
    ticketToken: TOKEN,
    status: "REGISTERED",
    checkedInAt: null,
    user: { name: "Ada Lovelace" },
    ...overrides,
  };
}

/** Runs a check-in and returns the AppError it rejected with. */
async function rejection(overrides: Partial<Parameters<typeof checkInAttendee>[1]> = {}) {
  try {
    await checkInAttendee(asDb, { event: EVENT, ticketToken: TOKEN, now: DURING, ...overrides });
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the check-in to be rejected");
}

beforeEach(() => {
  process.env.JWT_TICKET_SECRET = "test-ticket-secret";
  db.registration.updateMany.mockResolvedValue({ count: 1 });
  db.registration.findUnique.mockResolvedValue(stored());
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("checkInAttendee — success", () => {
  it("claims the registration and returns the attendee's name and the check-in time", async () => {
    const result = await checkInAttendee(asDb, { event: EVENT, ticketToken: TOKEN, now: DURING });

    expect(result).toEqual({
      registrationId: "reg-1",
      checkedInAt: DURING,
      attendeeName: "Ada Lovelace",
    });
  });

  it("claims with one conditional update: this event, this exact token, still REGISTERED, not yet checked in", async () => {
    await checkInAttendee(asDb, { event: EVENT, ticketToken: TOKEN, now: DURING });

    expect(db.registration.updateMany).toHaveBeenCalledTimes(1);
    expect(db.registration.updateMany).toHaveBeenCalledWith({
      where: {
        id: "reg-1",
        eventId: "evt-1",
        ticketToken: TOKEN,
        status: "REGISTERED",
        checkedInAt: null,
      },
      data: { checkedInAt: DURING },
    });
  });
});

describe("checkInAttendee — event state", () => {
  it.each(["CANCELLED", "FLAGGED"])(
    "refuses a %s event with 409 EVENT_NOT_OPEN, without touching the database",
    async (status) => {
      const error = await rejection({ event: { ...EVENT, status } });

      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("EVENT_NOT_OPEN");
      expect(db.registration.updateMany).not.toHaveBeenCalled();
    },
  );

  it("refuses once the grace period after the event ends has passed (409 CHECKIN_CLOSED)", async () => {
    const tooLate = new Date(EVENT.endTime.getTime() + CHECKIN_GRACE_MS + 1);

    const error = await rejection({ now: tooLate });

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CHECKIN_CLOSED");
    expect(db.registration.updateMany).not.toHaveBeenCalled();
  });

  it("still allows check-in at exactly the end of the grace period", async () => {
    const lastMoment = new Date(EVENT.endTime.getTime() + CHECKIN_GRACE_MS);

    const result = await checkInAttendee(asDb, {
      event: EVENT,
      ticketToken: TOKEN,
      now: lastMoment,
    });

    expect(result.registrationId).toBe("reg-1");
  });

  it("has no earliest time: a week before the event is fine", async () => {
    const earlyBird = new Date("2026-10-31T12:00:00.000Z");

    const result = await checkInAttendee(asDb, {
      event: EVENT,
      ticketToken: TOKEN,
      now: earlyBird,
    });

    expect(result.registrationId).toBe("reg-1");
  });

  it("reports the event problem even when the ticket is also bad (it says nothing about the ticket)", async () => {
    const error = await rejection({
      event: { ...EVENT, status: "CANCELLED" },
      ticketToken: "junk",
    });

    expect(error.code).toBe("EVENT_NOT_OPEN");
  });
});

describe("checkInAttendee — bad tokens (400 INVALID_TICKET)", () => {
  const otherSecretToken = jwt.sign(
    { registrationId: "reg-1", eventId: "evt-1" },
    "another-secret",
  );
  const wrongEventToken = () => signTicketToken({ registrationId: "reg-1", eventId: "evt-2" });
  const noClaimsToken = () => jwt.sign({ hello: "world" }, "test-ticket-secret");
  const tampered = () => `${TOKEN.slice(0, -2)}${TOKEN.endsWith("A") ? "B" : "A"}A`;

  it.each([
    ["garbage", () => "not-a-token"],
    ["empty", () => ""],
    ["far too long", () => "a".repeat(2_001)],
    ["tampered after signing", tampered],
    ["signed with a different secret", () => otherSecretToken],
    ["a ticket for a different event", wrongEventToken],
    ["a validly signed token without ticket claims", noClaimsToken],
  ])("rejects %s", async (_label, makeToken) => {
    const error = await rejection({ ticketToken: makeToken() });

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INVALID_TICKET");
    expect(db.registration.updateMany).not.toHaveBeenCalled();
  });

  it("answers every bad token with exactly the same message and no details", async () => {
    const errors = await Promise.all([
      rejection({ ticketToken: "not-a-token" }),
      rejection({ ticketToken: otherSecretToken }),
      rejection({ ticketToken: wrongEventToken() }),
      rejection({ ticketToken: noClaimsToken() }),
    ]);

    for (const error of errors) {
      expect(error.message).toBe("Invalid ticket.");
      expect(error.details).toBe(undefined);
    }
  });

  it("does not disguise a missing server secret as an invalid ticket", async () => {
    delete process.env.JWT_TICKET_SECRET;

    const error = await rejection();

    expect(error instanceof AppError).toBe(false);
    expect(error.message).toContain("JWT_TICKET_SECRET");
  });
});

describe("checkInAttendee — authentic token, nothing claimed", () => {
  beforeEach(() => {
    db.registration.updateMany.mockResolvedValue({ count: 0 });
  });

  it("returns 409 ALREADY_CHECKED_IN with the original time and the attendee's name", async () => {
    const earlier = new Date("2026-11-07T22:15:00.000Z");
    db.registration.findUnique.mockResolvedValue(stored({ checkedInAt: earlier }));

    const error = await rejection();

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("ALREADY_CHECKED_IN");
    expect(error.details).toEqual({ checkedInAt: earlier, attendee: { name: "Ada Lovelace" } });
  });

  it.each([
    ["no registration exists", () => null],
    ["it belongs to another event", () => stored({ eventId: "evt-2" })],
    ["the stored token is a different one (superseded)", () => stored({ ticketToken: "newer" })],
    ["the registration was cancelled", () => stored({ status: "CANCELLED" })],
    ["the attendee is only waitlisted", () => stored({ status: "WAITLISTED" })],
    ["its state changed mid-scan", () => stored()],
  ])("answers 400 INVALID_TICKET when %s", async (_label, makeRow) => {
    db.registration.findUnique.mockResolvedValue(makeRow());

    const error = await rejection();

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INVALID_TICKET");
    expect(error.message).toBe("Invalid ticket.");
  });

  it("does not reveal a prior check-in when the token has been superseded", async () => {
    db.registration.findUnique.mockResolvedValue(
      stored({ ticketToken: "newer", checkedInAt: new Date() }),
    );

    const error = await rejection();

    expect(error.code).toBe("INVALID_TICKET");
  });
});

describe("checkInAttendee — logging", () => {
  it("logs the real reason server-side with the event and scanner, but never the token", async () => {
    await rejection({ ticketToken: "SECRET-LOOKING-GARBAGE", scannedBy: "organizer-1" });

    expect(mockedWarn).toHaveBeenCalledTimes(1);
    const [fields] = mockedWarn.mock.calls[0];
    expect(fields).toEqual({
      eventId: "evt-1",
      scannedBy: "organizer-1",
      reason: "bad_signature_or_malformed",
    });
    expect(JSON.stringify(mockedWarn.mock.calls)).not.toContain("SECRET-LOOKING-GARBAGE");
  });
});

describe("getCheckInStats", () => {
  const event = { id: "evt-1", maxCapacity: 10 };

  it("counts seated, checked-in and waitlisted attendees from one grouped query", async () => {
    db.registration.groupBy.mockResolvedValue([
      { status: "REGISTERED", _count: { _all: 3, checkedInAt: 2 } },
      { status: "WAITLISTED", _count: { _all: 2, checkedInAt: 0 } },
    ]);

    const stats = await getCheckInStats(asDb, event);

    expect(stats).toEqual({
      capacity: 10,
      registered: 3,
      checkedIn: 2,
      notCheckedIn: 1,
      waitlisted: 2,
    });
    expect(db.registration.groupBy).toHaveBeenCalledTimes(1);
    expect(db.registration.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["status"],
        where: { eventId: "evt-1", status: { in: ["REGISTERED", "WAITLISTED"] } },
      }),
    );
  });

  it("returns zeros for an event with no registrations", async () => {
    db.registration.groupBy.mockResolvedValue([]);

    const stats = await getCheckInStats(asDb, event);

    expect(stats).toEqual({
      capacity: 10,
      registered: 0,
      checkedIn: 0,
      notCheckedIn: 0,
      waitlisted: 0,
    });
  });

  it("copes with an event that has only a waitlist", async () => {
    db.registration.groupBy.mockResolvedValue([
      { status: "WAITLISTED", _count: { _all: 4, checkedInAt: 0 } },
    ]);

    const stats = await getCheckInStats(asDb, event);

    expect(stats.registered).toBe(0);
    expect(stats.waitlisted).toBe(4);
  });
});
