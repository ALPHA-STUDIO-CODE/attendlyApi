import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import * as dotenv from "dotenv";

export default async function globalSetup(): Promise<void> {
  dotenv.config();

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Copy .env.example to .env and fill in a test database URL.",
    );
  }

  // Point the whole test run at the test database, never the dev one.
  process.env.DATABASE_URL = testDatabaseUrl;

  const migrationsDir = join(__dirname, "..", "prisma", "migrations");
  const hasMigrations = existsSync(migrationsDir) && readdirSync(migrationsDir).length > 0;

  if (!hasMigrations) {
    // No migrations exist yet (schema.prisma has no models — see Phase B).
    // Nothing to reset against; the connectivity test just needs a reachable
    // database and a generated client, both handled outside this hook.
    console.log("[globalSetup] No migrations found yet — skipping test DB reset.");
    return;
  }

  try {
    execSync("npx prisma migrate reset --force --skip-seed --skip-generate", {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error(
      "Failed to reset the test database via `prisma migrate reset`. Make sure " +
        "TEST_DATABASE_URL points at a reachable Postgres instance and that " +
        "`npx prisma generate` has been run at least once.\n" +
        String(error),
    );
  }
}
