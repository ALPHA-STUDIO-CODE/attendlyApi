import bcrypt from "bcrypt";
import { Router } from "express";
import { prisma } from "../db/prisma";
import { hashPassword, verifyPassword } from "../auth/password";
import { signAccessToken } from "../auth/jwt";
import { registerSchema, loginSchema } from "../validation/authSchemas";
import { AppError, ValidationError, ConflictError, AuthError } from "../errors";
import type { User } from "@prisma/client";

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

function toPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    authProvider: user.authProvider,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
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
  res.status(200).json({ user: toPublicUser(user), accessToken });
});
