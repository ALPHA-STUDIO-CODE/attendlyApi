import { prisma } from "../db/prisma";
import { generateOpaqueToken, hashOpaqueToken } from "./tokenUtils";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const REFRESH_TOKEN_COOKIE_NAME = "refreshToken";

export function getRefreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/api/auth",
    maxAge: REFRESH_TOKEN_TTL_MS,
  };
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const rawToken = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return rawToken;
}

export class RefreshTokenReuseError extends Error {
  constructor(readonly userId: string) {
    super("Refresh token reuse detected.");
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super("Invalid or expired refresh token.");
  }
}

export async function rotateRefreshToken(
  rawToken: string,
): Promise<{ userId: string; newRawToken: string }> {
  const tokenHash = hashOpaqueToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw new InvalidRefreshTokenError();
  }

  if (existing.revokedAt) {
    await revokeAllUserRefreshTokens(existing.userId);
    throw new RefreshTokenReuseError(existing.userId);
  }

  if (existing.expiresAt < new Date()) {
    throw new InvalidRefreshTokenError();
  }

  const newRawToken = generateOpaqueToken();
  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: hashOpaqueToken(newRawToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    }),
  ]);

  return { userId: existing.userId, newRawToken };
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function deleteAllUserRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

export async function deleteRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashOpaqueToken(rawToken);
  await prisma.refreshToken.deleteMany({ where: { tokenHash } });
}
