import type { Config } from "jest";

// Integration tests: hit the real (test) database via globalSetup/teardown.
// Deliberately non-recursive (`test/*.test.ts`, not `test/**`) so it never
// picks up test/unit/ — those run instantly, without a DB reset, via
// jest.unit.config.ts instead.
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/test/*.test.ts"],
  globalSetup: "<rootDir>/test/globalSetup.ts",
  globalTeardown: "<rootDir>/test/globalTeardown.ts",
  clearMocks: true,
  verbose: true,
  // Default (5000ms) is tight for integration tests hitting a hosted
  // Postgres instance (e.g. Supabase) over a connection pooler rather than
  // localhost. Individual slow tests can still override with a third
  // argument to it()/test() if they need more.
  testTimeout: 15000,
};

export default config;
