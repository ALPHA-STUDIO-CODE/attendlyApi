import { prisma } from "../db/prisma";
import { logger } from "../logger";
import type { SendEmailResult } from "../integrations/resend";
import { deliver } from "./deliver";
import {
  registrationConfirmationEmail,
  waitlistJoinedEmail,
  waitlistPromotionEmail,
} from "./templates";

export interface RegistrationConfirmationEmailOptions {
  promotedFromWaitlist?: boolean;
}

export async function queueRegistrationConfirmationEmail(
  registrationId: string,
  options: RegistrationConfirmationEmailOptions = {},
): Promise<SendEmailResult> {
  try {
    const registration = await prisma.registration.findUnique({
      where: { id: registrationId },
      include: { user: true, event: true },
    });
    if (!registration) {
      logger.error({ registrationId }, "Cannot send registration email: registration not found");
      return { ok: false, error: "Registration not found." };
    }

    const { user, event } = registration;
    const base = { to: user.email, relatedId: registration.id };

    if (options.promotedFromWaitlist) {
      return await deliver({
        ...base,
        kind: "WAITLIST_PROMOTION",
        build: () => waitlistPromotionEmail({ userName: user.name, event }),
      });
    }
    if (registration.status === "WAITLISTED") {
      return await deliver({
        ...base,
        kind: "WAITLIST_JOINED",
        build: () =>
          waitlistJoinedEmail({
            userName: user.name,
            event,
            position: registration.waitlistPosition,
          }),
      });
    }
    return await deliver({
      ...base,
      kind: "REGISTRATION_CONFIRMATION",
      build: () => registrationConfirmationEmail({ userName: user.name, event }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ registrationId, error: message }, "Registration email failed unexpectedly");
    return { ok: false, error: message };
  }
}
