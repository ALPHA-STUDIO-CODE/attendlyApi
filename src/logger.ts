import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.body.password",
      "req.body.passwordHash",
      "req.body.token",
      "req.body.refreshToken",
      "req.body.accessToken",
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.tokenHash",
    ],
    censor: "[REDACTED]",
  },
});
