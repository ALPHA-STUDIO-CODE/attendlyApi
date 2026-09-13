import type { Config } from "jest";

// Unit tests: pure logic, no database. No globalSetup/teardown, so these
// run instantly with no test-DB reset overhead.
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
  clearMocks: true,
  verbose: true,
};

export default config;
