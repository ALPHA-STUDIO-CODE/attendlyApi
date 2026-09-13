import express, { Express } from "express";
import request from "supertest";
import { requestIdMiddleware } from "../../src/middleware/requestId";
import { errorMiddleware } from "../../src/middleware/errorHandler";
import { ValidationError } from "../../src/errors";

// This app is built purely for testing the shared middleware in isolation
// — it is not, and should never become, a route mounted in src/app.ts.
// The middleware under test here (requestIdMiddleware, errorMiddleware) is
// the same code that's wired into the real app.
function buildTestApp(): Express {
  const app = express();
  app.use(requestIdMiddleware);

  app.get("/throws-known", () => {
    throw new ValidationError("Invalid input", { field: "email" }, "BAD_EMAIL");
  });

  app.get("/throws-unknown", () => {
    throw new Error("Something exploded internally");
  });

  app.use(errorMiddleware);
  return app;
}

describe("error-handling middleware", () => {
  const app = buildTestApp();

  it("returns the standard { error: { code, message, details } } envelope for a known AppError", async () => {
    const response = await request(app).get("/throws-known");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "BAD_EMAIL",
        message: "Invalid input",
        details: { field: "email" },
      },
    });
  });

  it("returns a generic 500 with no leaked details for an unrecognized error", async () => {
    const response = await request(app).get("/throws-unknown");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong. Please try again.",
        details: null,
      },
    });
    // Must never leak the real error message or a stack trace.
    expect(JSON.stringify(response.body)).not.toContain("Something exploded internally");
  });

  it("includes a request ID on the response, generating one if none was sent", async () => {
    const response = await request(app).get("/throws-known");

    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
    expect(response.headers["x-request-id"].length).toBeGreaterThan(0);
  });

  it("echoes back a caller-supplied request ID instead of generating a new one", async () => {
    const response = await request(app)
      .get("/throws-known")
      .set("x-request-id", "caller-supplied-id-123");

    expect(response.headers["x-request-id"]).toBe("caller-supplied-id-123");
  });
});
