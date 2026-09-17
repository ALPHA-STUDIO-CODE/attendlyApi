import { randomBytes, createHash } from "crypto";

/**
 * A cryptographically random, high-entropy opaque token (512 bits) —
 * suitable for anything sent to a user that later needs to be looked up
 * by its hash: refresh tokens, password-reset tokens, etc. Not for
 * anything that needs to be memorable or user-chosen (that's what
 * src/auth/password.ts's bcrypt hashing is for).
 */
export function generateOpaqueToken(): string {
  return randomBytes(64).toString("hex");
}

/**
 * SHA-256 is sufficient (and standard practice) for hashing these at
 * rest — unlike a password, brute-forcing a 512-bit random token is
 * infeasible, so there's no need for bcrypt's deliberate slowness here.
 */
export function hashOpaqueToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
