import { logger } from "../logger";

export async function queueRegistrationConfirmationEmail(registrationId: string): Promise<void> {
  logger.info(
    { registrationId },
    "[stub] Would queue registration confirmation email here (Phase I wires up the real send).",
  );
}
