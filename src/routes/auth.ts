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
import { registerSchema, loginSchema, updateMeSchema } from "../validation/authSchemas";
import { AppError, ValidationError, ConflictError, AuthError } from "../errors";
import { requireAuth } from "../middleware/requireAuth";
import { toPublicUser } from "../auth/publicUser";

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
    throw new AppError(403, "ACCOUNT_SUSPENDED", "Your account has been suspended.");
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
