import { logger } from "../logger";
import type { User } from "@prisma/client";

/**
 * Stub for now — Phase I wires this up to a real Resend call. Per spec
 * §8.5, email failures must never block the action that triggered them,
 * so this deliberately can't throw: it just logs and resolves. Kept as
 * its own function (rather than inlined in the route handler) so I2 can
 * swap the implementation here without touching src/routes/auth.ts.
 */
export async function sendPasswordResetEmail(user: User, rawToken: string): Promise<void> {
  logger.info(
    { userId: user.id, email: user.email },
    "[stub] Would send password reset email here (Phase I wires up the real send).",
  );

  // Only surfaced outside production, and only because there's no real
  // email delivery yet — without this, there'd be no way to manually
  // exercise POST /api/auth/reset-password during development. Phase I
  // deletes this whole branch along with the rest of the stub.
  if (process.env.NODE_ENV !== "production") {
    logger.debug({ userId: user.id, rawToken }, "[stub, dev-only] Password reset token");
  }
}
