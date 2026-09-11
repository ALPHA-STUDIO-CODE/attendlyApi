import bcrypt from "bcrypt";

// Cost factor 12 per spec §12.1's unit test coverage requirements — a
// reasonable balance of hashing cost vs. login latency as of 2026 hardware.
const SALT_ROUNDS = 12;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export async function verifyPassword(
  plainTextPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, passwordHash);
}
