import { JsonWebTokenError } from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { verifyTicketToken } from "../auth/ticketToken";
import { ConflictError, ValidationError } from "../errors";
import { logger } from "../logger";
import { ACTIVE_REGISTRATION_STATUSES } from "./registrationListing";

export const CHECKIN_GRACE_MS = 24 * 60 * 60 * 1000;

const MAX_TICKET_TOKEN_LENGTH = 2_000;

export interface CheckInEvent {
  id: string;
  status: string;
  endTime: Date;
}

export interface CheckInParams {
  event: CheckInEvent;
  ticketToken: string;
  scannedBy?: string;
  now?: Date;
}

export interface CheckInSuccess {
  registrationId: string;
  checkedInAt: Date;
  attendeeName: string;
}

function invalidTicket(params: CheckInParams, reason: string): ValidationError {
  logger.warn(
    { eventId: params.event.id, scannedBy: params.scannedBy, reason },
    "Check-in rejected: invalid ticket",
  );
  return new ValidationError("Invalid ticket.", undefined, "INVALID_TICKET");
}

function readRegistrationId(params: CheckInParams): string {
  const { ticketToken, event } = params;
  if (ticketToken.length === 0 || ticketToken.length > MAX_TICKET_TOKEN_LENGTH) {
    throw invalidTicket(params, "unusable_length");
  }

  let payload: unknown;
  try {
    payload = verifyTicketToken(ticketToken);
  } catch (error) {
    if (error instanceof JsonWebTokenError) {
      throw invalidTicket(params, "bad_signature_or_malformed");
    }
    throw error;
  }

  const claims = payload as { registrationId?: unknown; eventId?: unknown } | null;
  if (typeof claims?.registrationId !== "string" || typeof claims.eventId !== "string") {
    throw invalidTicket(params, "bad_payload");
  }
  if (claims.eventId !== event.id) {
    throw invalidTicket(params, "wrong_event");
  }
  return claims.registrationId;
}

export async function checkInAttendee(
  db: Prisma.TransactionClient,
  params: CheckInParams,
): Promise<CheckInSuccess> {
  const { event, ticketToken } = params;
  const now = params.now ?? new Date();

  if (event.status !== "PUBLISHED") {
    throw new ConflictError("This event is not open for check-in.", undefined, "EVENT_NOT_OPEN");
  }
  if (now.getTime() > event.endTime.getTime() + CHECKIN_GRACE_MS) {
    throw new ConflictError("Check-in for this event has closed.", undefined, "CHECKIN_CLOSED");
  }

  const registrationId = readRegistrationId(params);

  const claimed = await db.registration.updateMany({
    where: {
      id: registrationId,
      eventId: event.id,
      ticketToken,
      status: "REGISTERED",
      checkedInAt: null,
    },
    data: { checkedInAt: now },
  });

  const registration = await db.registration.findUnique({
    where: { id: registrationId },
    select: {
      eventId: true,
      ticketToken: true,
      status: true,
      checkedInAt: true,
      user: { select: { name: true } },
    },
  });

  if (claimed.count === 1) {
    if (!registration) {
      throw invalidTicket(params, "vanished_after_claim");
    }
    return { registrationId, checkedInAt: now, attendeeName: registration.user.name };
  }

  if (!registration || registration.eventId !== event.id) {
    throw invalidTicket(params, "unknown_registration");
  }
  if (registration.ticketToken !== ticketToken) {
    throw invalidTicket(params, "superseded_token");
  }
  if (registration.status !== "REGISTERED") {
    throw invalidTicket(params, "not_registered");
  }
  if (registration.checkedInAt) {
    throw new ConflictError(
      "This ticket has already been checked in.",
      { checkedInAt: registration.checkedInAt, attendee: { name: registration.user.name } },
      "ALREADY_CHECKED_IN",
    );
  }
  throw invalidTicket(params, "state_changed_during_scan");
}

export interface CheckInStats {
  capacity: number;
  registered: number;
  checkedIn: number;
  notCheckedIn: number;
  waitlisted: number;
}

export async function getCheckInStats(
  db: Prisma.TransactionClient,
  event: { id: string; maxCapacity: number },
): Promise<CheckInStats> {
  const groups = await db.registration.groupBy({
    by: ["status"],
    where: { eventId: event.id, status: { in: ACTIVE_REGISTRATION_STATUSES } },
    _count: { _all: true, checkedInAt: true },
  });

  const seated = groups.find((group) => group.status === "REGISTERED");
  const waiting = groups.find((group) => group.status === "WAITLISTED");
  const registered = seated?._count._all ?? 0;
  const checkedIn = seated?._count.checkedInAt ?? 0;

  return {
    capacity: event.maxCapacity,
    registered,
    checkedIn,
    notCheckedIn: registered - checkedIn,
    waitlisted: waiting?._count._all ?? 0,
  };
}
