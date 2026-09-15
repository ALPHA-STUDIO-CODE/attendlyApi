import { randomBytes, createHash } from "crypto";
import { prisma } from "../db/prisma";

// 7-30 days per spec §5; 30 is chosen for a generous "stay logged in"
// experience — rotation on every refresh keeps the security cost of the
// longer end of that range low.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const REFRESH_TOKEN_COOKIE_NAME = "refreshToken";

export function getRefreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    // Scoped to /api/auth rather than the whole site — the browser only
    // needs to send this cookie to the endpoints that actually read it.
    path: "/api/auth",
    maxAge: REFRESH_TOKEN_TTL_MS,
  };
}

function generateRawToken(): string {
  // 512 bits of entropy — brute-forcing this is infeasible, which is why
  // (per spec §5) a fast hash like SHA-256 is sufficient for at-rest
  // storage here, unlike a user-chosen password.
  return randomBytes(64).toString("hex");
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Creates a new refresh token row for a user and returns the raw
 * (unhashed) token to set on the response cookie. Only the hash is
 * persisted.
 */
export async function issueRefreshToken(userId: string): Promise<string> {
  const rawToken = generateRawToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
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

/**
 * Validates a presented refresh token and, if valid, rotates it: the old
 * token is marked revoked and a new one is issued. If the presented token
 * has *already* been revoked (i.e. it was rotated out previously and is
 * now being presented again — a sign of theft/reuse), every active
 * refresh token for that user is revoked and RefreshTokenReuseError is
 * thrown, forcing re-login everywhere per spec §9.
 */
export async function rotateRefreshToken(
  rawToken: string,
): Promise<{ userId: string; newRawToken: string }> {
  const tokenHash = hashToken(rawToken);
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

  const newRawToken = generateRawToken();
  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: hashToken(newRawToken),
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

/**
 * Logout: hard-deletes the matching row per spec §5, rather than marking
 * it revoked — unlike rotation, there's no reuse-detection value in
 * keeping a deliberately-logged-out token around.
 */
export async function deleteRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await prisma.refreshToken.deleteMany({ where: { tokenHash } });
}
