import bcrypt from "bcrypt";
import { Router, Response } from "express";
import { prisma } from "../db/prisma";
import { hashPassword, verifyPassword } from "../auth/password";
import { signAccessToken } from "../auth/jwt";
import {
  issueRefreshToken,
  rotateRefreshToken,
  deleteRefreshToken,
  getRefreshCookieOptions,
  REFRESH_TOKEN_COOKIE_NAME,
  RefreshTokenReuseError,
  InvalidRefreshTokenError,
} from "../auth/refreshToken";
import {
  registerSchema,
  loginSchema,
  updateMeSchema,
  oauthCodeSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../validation/authSchemas";
import { ValidationError, ConflictError, AuthError, ForbiddenError } from "../errors";
import { requireAuth } from "../middleware/requireAuth";
import { toPublicUser } from "../auth/publicUser";
import { exchangeGoogleAuthCode } from "../auth/oauth/google";
import { exchangeGitHubAuthCode } from "../auth/oauth/github";
import { findOrCreateOAuthUser } from "../auth/oauthUser";
import { generateOpaqueToken, hashOpaqueToken } from "../auth/tokenUtils";
import { sendPasswordResetEmail } from "../email/sendPasswordResetEmail";

export const authRouter = Router();

// Precomputed once at module load. Used to keep login's response time
// constant whether or not the email exists, so bcrypt.compare's ~500ms
// cost can't be used as a timing oracle to enumerate registered emails.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("dummy-password-for-timing-safety", 12);

function zodIssuesToFields(
  issues: { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_root";
    if (!(key in fields)) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

function setRefreshCookie(res: Response, rawToken: string): void {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, rawToken, getRefreshCookieOptions());
}

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid registration details.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }
  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError("An account with this email already exists.", undefined, "EMAIL_TAKEN");
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, passwordHash, name } });

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = await issueRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  res.status(201).json({ user: toPublicUser(user), accessToken });
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid login details.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !passwordMatches) {
    throw new AuthError("Invalid email or password.", undefined, "INVALID_CREDENTIALS");
  }

  // Checked after credential verification, deliberately: revealing account
  // status before proving the caller knows the password would let an
  // attacker enumerate suspended accounts without valid credentials.
  if (user.status === "SUSPENDED") {
    throw new ForbiddenError("Your account has been suspended.", undefined, "ACCOUNT_SUSPENDED");
  }

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = await issueRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ user: toPublicUser(user), accessToken });
});

authRouter.post("/refresh", async (req, res) => {
  const presentedToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
  if (!presentedToken) {
    throw new AuthError("No refresh token provided.", undefined, "MISSING_REFRESH_TOKEN");
  }

  try {
    const { userId, newRawToken } = await rotateRefreshToken(presentedToken);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // The user was deleted after the token was issued — treat like any
      // other invalid token rather than a distinct case.
      throw new InvalidRefreshTokenError();
    }

    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    setRefreshCookie(res, newRawToken);
    res.status(200).json({ accessToken });
  } catch (err) {
    if (err instanceof RefreshTokenReuseError) {
      // Reuse of an already-rotated token: every session for this user has
      // just been revoked (inside rotateRefreshToken). Clear the cookie
      // that triggered it and force re-login, per spec §9.
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, getRefreshCookieOptions());
      throw new AuthError(
        "This session is no longer valid. Please log in again.",
        undefined,
        "REFRESH_TOKEN_REUSE_DETECTED",
      );
    }
    if (err instanceof InvalidRefreshTokenError) {
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, getRefreshCookieOptions());
      throw new AuthError("Invalid or expired refresh token.", undefined, "INVALID_REFRESH_TOKEN");
    }
    throw err;
  }
});

authRouter.post("/logout", async (req, res) => {
  const presentedToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
  if (presentedToken) {
    await deleteRefreshToken(presentedToken);
  }
  res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, getRefreshCookieOptions());
  res.status(200).json({ success: true });
});

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour, per spec

authRouter.post("/forgot-password", async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid email address.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Always 200, whether or not the email exists — a differing response
  // here would let an attacker enumerate registered emails via this
  // endpoint alone, with no credentials required at all.
  if (user) {
    const rawToken = generateOpaqueToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
      },
    });
    await sendPasswordResetEmail(user, rawToken);
  }

  res.status(200).json({ success: true });
});

authRouter.post("/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid reset request.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }
  const { token, password } = parsed.data;

  const tokenRow = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
  });

  // One generic error for "never existed," "already used," and "expired"
  // alike — matches the same reasoning as requireAuth's unified
  // TOKEN_EXPIRED code (spec §9): don't give an attacker probing tokens
  // any information about *why* a guess failed.
  if (!tokenRow || tokenRow.usedAt || tokenRow.expiresAt <= new Date()) {
    throw new AuthError("Invalid or expired reset token.", undefined, "INVALID_RESET_TOKEN");
  }

  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: tokenRow.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({
      where: { id: tokenRow.id },
      data: { usedAt: new Date() },
    }),
  ]);

  res.status(200).json({ success: true });
});

authRouter.post("/oauth/google", async (req, res) => {
  const parsed = oauthCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Missing or invalid authorization code.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }

  let profile;
  try {
    profile = await exchangeGoogleAuthCode(parsed.data.code);
  } catch {
    // Deliberately don't surface the underlying reason (network failure vs.
    // Google rejecting the code vs. malformed response) — none of that is
    // actionable for the client beyond "OAuth didn't work, try again."
    throw new AuthError("Failed to authenticate with Google.", undefined, "OAUTH_EXCHANGE_FAILED");
  }

  const user = await findOrCreateOAuthUser(profile, "GOOGLE");

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = await issueRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ user: toPublicUser(user), accessToken });
});

authRouter.post("/oauth/github", async (req, res) => {
  const parsed = oauthCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Missing or invalid authorization code.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }

  let profile;
  try {
    profile = await exchangeGitHubAuthCode(parsed.data.code);
  } catch {
    throw new AuthError("Failed to authenticate with GitHub.", undefined, "OAUTH_EXCHANGE_FAILED");
  }

  const user = await findOrCreateOAuthUser(profile, "GITHUB");

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = await issueRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ user: toPublicUser(user), accessToken });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  // requireAuth guarantees req.user is set; the user row itself could in
  // principle have been deleted since the token was issued.
  const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
  if (!user) {
    throw new AuthError("User account no longer exists.", undefined, "USER_NOT_FOUND");
  }
  res.status(200).json({ user: toPublicUser(user) });
});

authRouter.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid profile update.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }

  const user = await prisma.user.update({
    where: { id: req.user!.sub },
    data: parsed.data, // .strict() schema guarantees only `name` can appear here
  });
  res.status(200).json({ user: toPublicUser(user) });
});
