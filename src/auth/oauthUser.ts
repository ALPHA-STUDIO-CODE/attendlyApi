import { prisma } from "../db/prisma";
import { isUniqueConstraintError } from "../db/prismaErrors";
import { ConflictError } from "../errors";
import type { AuthProvider, User } from "@prisma/client";
import type { OAuthProfile } from "./oauth/google";

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
      throw new ConflictError(
        "An account with this email already exists. Log in with your existing method instead.",
        undefined,
        "EMAIL_TAKEN",
      );
    }
    throw err;
  }
}
