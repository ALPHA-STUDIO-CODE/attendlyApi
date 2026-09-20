import { prisma } from "../db/prisma";
import { logger } from "../logger";

export async function queueCancellationEmails(eventId: string): Promise<void> {
  const affectedCount = await prisma.registration.count({
    where: { eventId, status: { in: ["REGISTERED", "WAITLISTED"] } },
  });

  logger.info(
    { eventId, affectedCount },
    "[stub] Would queue cancellation emails here (Phase I wires up the real send).",
  );
}
