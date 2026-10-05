import { randomUUID } from "crypto";
import type { Prisma, Registration } from "@prisma/client";
import { NotFoundError, ConflictError } from "../errors";
import { isUniqueConstraintError } from "../db/prismaErrors";
import { assignWaitlistPosition } from "./waitlist";
import { signTicketToken } from "../auth/ticketToken";

export interface RegisterForEventParams {
  eventId: string;
  userId: string;
}

interface LockedEventRow {
  id: string;
  maxCapacity: number;
  status: string;
  isLocked: boolean;
}

export async function registerForEvent(
  tx: Prisma.TransactionClient,
  { eventId, userId }: RegisterForEventParams,
): Promise<Registration> {
  const rows = await tx.$queryRaw<LockedEventRow[]>`
    SELECT "id", "maxCapacity", "status", "isLocked"
    FROM "Event"
    WHERE "id" = ${eventId}
    FOR UPDATE
  `;
  const event = rows[0];
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  if (event.status !== "PUBLISHED") {
    throw new ConflictError(
      "This event is not open for registration.",
      undefined,
      "EVENT_NOT_OPEN",
    );
  }

  const existing = await tx.registration.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (existing && existing.status !== "CANCELLED") {
    throw new ConflictError(
      "You are already registered for this event.",
      undefined,
      "ALREADY_REGISTERED",
    );
  }

  const registeredCount = await tx.registration.count({
    where: { eventId, status: "REGISTERED" },
  });

  let status: "REGISTERED" | "WAITLISTED";
  let waitlistPosition: number | null;
  if (registeredCount < event.maxCapacity) {
    status = "REGISTERED";
    waitlistPosition = null;
  } else {
    status = "WAITLISTED";
    const { _max } = await tx.registration.aggregate({
      where: { eventId, status: "WAITLISTED" },
      _max: { waitlistPosition: true },
    });
    waitlistPosition = assignWaitlistPosition(_max.waitlistPosition);
  }

  const registrationId = existing?.id ?? randomUUID();
  const ticketToken = signTicketToken({ registrationId, eventId });

  let registration: Registration;
  try {
    registration = existing
      ? await tx.registration.update({
          where: { id: existing.id },
          data: { status, waitlistPosition, checkedInAt: null, ticketToken },
        })
      : await tx.registration.create({
          data: { id: registrationId, eventId, userId, status, waitlistPosition, ticketToken },
        });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(
        "You are already registered for this event.",
        undefined,
        "ALREADY_REGISTERED",
      );
    }
    throw err;
  }

  if (!event.isLocked) {
    await tx.event.update({ where: { id: eventId }, data: { isLocked: true } });
  }

  return registration;
}
