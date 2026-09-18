import express from "express";
import request from "supertest";
import { requireAuth } from "../src/middleware/requireAuth";
import { requireRole } from "../src/middleware/requireRole";
import { errorMiddleware } from "../src/middleware/errorHandler";
import { signAccessToken } from "../src/auth/jwt";

function buildTestApp() {
  const app = express();
  app.get("/admin-only", requireAuth, requireRole("ADMIN"), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorMiddleware);
  return app;
}

describe("requireRole middleware", () => {
  const app = buildTestApp();

  it("returns 403 for an authenticated non-admin user", async () => {
    const token = signAccessToken({ sub: "some-user-id", role: "USER" });

    const response = await request(app).get("/admin-only").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
  });

  it("passes through for an authenticated admin user", async () => {
    const token = signAccessToken({ sub: "some-admin-id", role: "ADMIN" });

    const response = await request(app).get("/admin-only").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("returns 401 before even reaching the role check when there's no token at all", async () => {
    const response = await request(app).get("/admin-only");
    expect(response.status).toBe(401);
  });
});
