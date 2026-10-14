import type { Prisma, Report } from "@prisma/client";
import { ConflictError, NotFoundError } from "../errors";

export interface SubmitReportParams {
  eventId: string;
  reporterId: string;
  reason: string;
}

export async function submitReport(
  db: Prisma.TransactionClient,
  { eventId, reporterId, reason }: SubmitReportParams,
): Promise<Report> {
  const event = await db.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { id: true },
  });
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  const existing = await db.report.findFirst({
    where: { eventId, reporterId, status: "OPEN" },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError(
      "You have already reported this event. An admin will review it.",
      undefined,
      "ALREADY_REPORTED",
    );
  }

  return db.report.create({ data: { eventId, reporterId, reason } });
}
