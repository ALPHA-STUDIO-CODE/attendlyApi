import { logger } from "../logger";

export interface RegistrationConfirmationEmailOptions {
  promotedFromWaitlist?: boolean;
}

export async function queueRegistrationConfirmationEmail(
  registrationId: string,
  options: RegistrationConfirmationEmailOptions = {},
): Promise<void> {
  logger.info(
    { registrationId, promotedFromWaitlist: options.promotedFromWaitlist === true },
    "[stub] Would queue registration confirmation email here (Phase I wires up the real send).",
  );
}
