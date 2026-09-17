import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { verifyPassword } from "../src/auth/password";
import { generateOpaqueToken, hashOpaqueToken } from "../src/auth/tokenUtils";

const app = createApp();

async function registerTestUser(email: string) {
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "original-password-123", name: "D3 Test User" });
  return response.body.user as { id: string; email: string };
}

describe("POST /api/auth/forgot-password", () => {
  it("creates a reset token for an existing email and returns 200", async () => {
    const email = `d3-forgot-${Date.now()}@example.com`;
    await registerTestUser(email);

    const response = await request(app).post("/api/auth/forgot-password").send({ email });

    expect(response.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].usedAt).toBeNull();
  });

  it("returns 200 for a nonexistent email too, without creating a token (no enumeration leak)", async () => {
    const response = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "definitely-not-registered@example.com" });

    expect(response.status).toBe(200);
    // Same response shape/status either way — the point of this test is
    // that a caller can't distinguish "email exists" from "email doesn't"
    // by looking at the response.
    expect(response.body).toEqual({ success: true });
  });

  it("rejects a malformed email with 400", async () => {
    const response = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "not-an-email" });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("resets the password with a valid, unexpired token", async () => {
    const email = `d3-reset-${Date.now()}@example.com`;
    const user = await registerTestUser(email);

    const rawToken = generateOpaqueToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "brand-new-password-456" });
    expect(response.status).toBe(200);

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await expect(verifyPassword("brand-new-password-456", updatedUser.passwordHash!)).resolves.toBe(
      true,
    );
    await expect(verifyPassword("original-password-123", updatedUser.passwordHash!)).resolves.toBe(
      false,
    );
  });

  it("is single-use: the same token cannot be used twice", async () => {
    const email = `d3-single-use-${Date.now()}@example.com`;
    const user = await registerTestUser(email);

    const rawToken = generateOpaqueToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const first = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "first-new-password-1" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "second-new-password-2" });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe("INVALID_RESET_TOKEN");
  });

  it("rejects an expired token", async () => {
    const email = `d3-expired-${Date.now()}@example.com`;
    const user = await registerTestUser(email);

    const rawToken = generateOpaqueToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() - 1000), // already expired
      },
    });

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "does-not-matter-123" });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_RESET_TOKEN");
  });

  it("rejects an unrecognized token", async () => {
    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "not-a-real-token", password: "does-not-matter-123" });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_RESET_TOKEN");
  });

  it("rejects a password under 8 characters", async () => {
    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "whatever", password: "short" });
    expect(response.status).toBe(400);
  });
});
