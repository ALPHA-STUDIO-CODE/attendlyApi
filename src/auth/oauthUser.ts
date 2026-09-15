import { prisma } from "../db/prisma";
import { ConflictError } from "../errors";
import type { AuthProvider, User } from "@prisma/client";
import type { OAuthProfile } from "./oauth/google";

/**
 * Finds the existing user for this OAuth provider + providerId (spec §5:
 * match by providerId on subsequent logins), or creates one on first
 * login.
 *
 * Deliberately does NOT match/link accounts by email alone. Spec doesn't
 * address an OAuth email colliding with an existing account under a
 * different provider, and auto-linking accounts based solely on an email
 * match — without an explicit, user-initiated "link accounts" step — is a
 * security-relevant product decision too significant to make implicitly
 * (a provider reporting an email as "verified" isn't the same as the
 * account's owner consenting to merge it with an existing password-based
 * account). Flagged as an assumption to confirm with stakeholders; revisit
 * if account linking is wanted.
 */
export async function findOrCreateOAuthUser(
  profile: OAuthProfile,
  provider: AuthProvider,
): Promise<User> {
  const existing = await prisma.user.findFirst({
    where: { authProvider: provider, providerId: profile.providerId },
  });
  if (existing) {
    return existing;
  }

  try {
    return await prisma.user.create({
      data: {
        email: profile.email,
        name: profile.name,
        authProvider: provider,
        providerId: profile.providerId,
        passwordHash: null,
      },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Email already belongs to a different account (another provider,
      // or a LOCAL password account) — see the assumption documented
      // above for why we refuse rather than silently link.
      throw new ConflictError(
        "An account with this email already exists. Log in with your existing method instead.",
        undefined,
        "EMAIL_TAKEN",
      );
    }
    throw err;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}
