import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";

const app = createApp();

async function createTestUser(emailPrefix: string) {
  return prisma.user.create({
    data: {
      email: `${emailPrefix}-${Date.now()}@example.com`,
      passwordHash: "hashed-password",
      name: "C5 Test User",
    },
  });
}

describe("GET /api/auth/me", () => {
  it("rejects a request with no token", async () => {
    const response = await request(app).get("/api/auth/me");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an expired token", async () => {
    const user = await createTestUser("c5-expired");
    const expiredToken = jwt.sign(
      { sub: user.id, role: user.role },
      process.env.JWT_ACCESS_SECRET!,
      { expiresIn: -10 },
    );

    const response = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects a malformed/tampered token with the same code as an expired one (spec §9: one code, one frontend trigger condition)", async () => {
    const response = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer not-a-real-token");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("returns the correct user for a valid token", async () => {
    const user = await createTestUser("c5-valid");
    const token = signAccessToken({ sub: user.id, role: user.role });

    const response = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(user.id);
    expect(response.body.user.email).toBe(user.email);
    expect(response.body.user.passwordHash).toBeUndefined();
  });
});

describe("PATCH /api/auth/me", () => {
  it("updates the user's name", async () => {
    const user = await createTestUser("c5-patch-name");
    const token = signAccessToken({ sub: user.id, role: user.role });

    const response = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Name" });

    expect(response.status).toBe(200);
    expect(response.body.user.name).toBe("Updated Name");

    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.name).toBe("Updated Name");
  });

  it("rejects an attempt to set disallowed fields (e.g. role) and leaves them unchanged", async () => {
    const user = await createTestUser("c5-patch-role");
    const token = signAccessToken({ sub: user.id, role: user.role });

    const response = await request(app)
      .patch("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Still Allowed", role: "ADMIN" });

    expect(response.status).toBe(400);

    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.role).toBe("USER"); // unchanged — the whole request was rejected
    expect(reloaded.name).toBe("C5 Test User"); // unchanged too, not just role
  });

  it("rejects a request with no token", async () => {
    const response = await request(app).patch("/api/auth/me").send({ name: "Nope" });
    expect(response.status).toBe(401);
  });
});
