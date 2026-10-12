import type { User } from "@prisma/client";
import type { SendEmailResult } from "../integrations/resend";
import { buildAppUrl } from "./appUrl";
import { deliver } from "./deliver";
import { passwordResetEmail } from "./templates";

export async function sendPasswordResetEmail(
  user: User,
  rawToken: string,
): Promise<SendEmailResult> {
  return deliver({
    kind: "PASSWORD_RESET",
    to: user.email,
    relatedId: user.id,
    build: () =>
      passwordResetEmail({
        userName: user.name,
        resetUrl: buildAppUrl(`/reset-password?token=${encodeURIComponent(rawToken)}`),
      }),
  });
}
