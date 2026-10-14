import type { Prisma, Registration } from "@prisma/client";
import { NotFoundError } from "../errors";

export interface CancelRegistrationParams {
  eventId: string;
  userId: string;
}

export interface CancelRegistrationResult {
  cancelled: Registration;
  promoted: Registration | null;
}

interface LockedEventRow {
  id: string;
  status: string;
  deletedAt: Date | null;
}

interface WaitlistHeadRow {
  id: string;
  waitlistPosition: number | null;
}

export async function cancelRegistration(
  tx: Prisma.TransactionClient,
  { eventId, userId }: CancelRegistrationParams,
): Promise<CancelRegistrationResult> {
  const eventRows = await tx.$queryRaw<LockedEventRow[]>`
    SELECT "id", "status", "deletedAt"
    FROM "Event"
    WHERE "id" = ${eventId}
    FOR UPDATE
  `;
  const event = eventRows[0];
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  const existing = await tx.registration.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!existing || existing.status === "CANCELLED") {
    throw new NotFoundError(
      "You are not registered for this event.",
      undefined,
      "REGISTRATION_NOT_FOUND",
    );
  }

  const wasRegistered = existing.status === "REGISTERED";
  const vacatedPosition = existing.waitlistPosition;

  const cancelled = await tx.registration.update({
    where: { id: existing.id },
    data: { status: "CANCELLED", waitlistPosition: null },
  });

  if (!wasRegistered) {
    // A waitlisted user leaving: no seat was freed, so no promotion.
    if (vacatedPosition !== null) {
      await closeWaitlistGap(tx, eventId, vacatedPosition);
    }
    return { cancelled, promoted: null };
  }

  // Don't fill seats of an event that is no longer open (e.g. CANCELLED), or
  // that an admin removed (Phase L): nobody should be told they got a seat.
  if (event.status !== "PUBLISHED" || event.deletedAt) {
    return { cancelled, promoted: null };
  }

  const headRows = await tx.$queryRaw<WaitlistHeadRow[]>`
    SELECT "id", "waitlistPosition"
    FROM "Registration"
    WHERE "eventId" = ${eventId} AND "status" = 'WAITLISTED'
    ORDER BY "waitlistPosition" ASC
    LIMIT 1
    FOR UPDATE
  `;
  const head = headRows[0];
  if (!head) {
    return { cancelled, promoted: null };
  }

  const promoted = await tx.registration.update({
    where: { id: head.id },
    data: { status: "REGISTERED", waitlistPosition: null },
  });

  if (head.waitlistPosition !== null) {
    await closeWaitlistGap(tx, eventId, head.waitlistPosition);
  }

  return { cancelled, promoted };
}

/** Moves every WAITLISTED row behind `vacatedPosition` up by one. */
async function closeWaitlistGap(
  tx: Prisma.TransactionClient,
  eventId: string,
  vacatedPosition: number,
): Promise<void> {
  await tx.registration.updateMany({
    where: { eventId, status: "WAITLISTED", waitlistPosition: { gt: vacatedPosition } },
    data: { waitlistPosition: { decrement: 1 } },
  });
}
