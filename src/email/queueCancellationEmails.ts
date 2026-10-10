import { prisma } from "../db/prisma";
import { logger } from "../logger";
import { ACTIVE_REGISTRATION_STATUSES } from "../business/registrationListing";
import { deliver } from "./deliver";
import { eventCancellationEmail } from "./templates";

export interface CancellationEmailSummary {
  total: number;
  sent: number;
  failed: number;
}

export async function queueCancellationEmails(eventId: string): Promise<CancellationEmailSummary> {
  const summary: CancellationEmailSummary = { total: 0, sent: 0, failed: 0 };
  try {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      logger.error({ eventId }, "Cannot send cancellation emails: event not found");
      return summary;
    }

    const registrations = await prisma.registration.findMany({
      where: { eventId, status: { in: ACTIVE_REGISTRATION_STATUSES } },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { name: true, email: true } } },
    });
    summary.total = registrations.length;

    for (const registration of registrations) {
      const result = await deliver({
        kind: "EVENT_CANCELLATION",
        to: registration.user.email,
        relatedId: registration.id,
        idempotencyKey: `event-cancellation/${registration.id}`,
        build: () => eventCancellationEmail({ userName: registration.user.name, event }),
      });
      if (result.ok) {
        summary.sent += 1;
      } else {
        summary.failed += 1;
      }
    }

    logger.info({ eventId, ...summary }, "Event cancellation emails finished");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ eventId, error: message, ...summary }, "Event cancellation emails aborted");
  }
  return summary;
}
