import request from "supertest";
import { createApp } from "../src/app";

const app = createApp();

describe("POST /api/auth/register", () => {
  it("registers a new user, returning 201 with no passwordHash in the response", async () => {
    const response = await request(app)
      .post("/api/auth/register")
      .send({
        email: `c3-register-${Date.now()}@example.com`,
        password: "correct-horse-battery-staple",
        name: "New User",
      });

    expect(response.status).toBe(201);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user.email).toContain("c3-register-");
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("correct-horse-battery-staple");
  });

  it("rejects a duplicate email with 409 EMAIL_TAKEN", async () => {
    const email = `c3-duplicate-${Date.now()}@example.com`;
    await request(app).post("/api/auth/register").send({
      email,
      password: "correct-horse-battery-staple",
      name: "First User",
    });

    const response = await request(app).post("/api/auth/register").send({
      email,
      password: "another-password-123",
      name: "Second User",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects a password under 8 characters with 400", async () => {
    const response = await request(app)
      .post("/api/auth/register")
      .send({
        email: `c3-weak-password-${Date.now()}@example.com`,
        password: "short",
        name: "Weak Password User",
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details.fields.password).toEqual(expect.any(String));
  });
});

describe("POST /api/auth/login", () => {
  async function registerTestUser(email: string, password: string) {
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, name: "Login Test User" });
  }

  it("logs in with correct credentials, returning 200 with an access token", async () => {
    const email = `c3-login-correct-${Date.now()}@example.com`;
    const password = "correct-horse-battery-staple";
    await registerTestUser(email, password);

    const response = await request(app).post("/api/auth/login").send({ email, password });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user.email).toBe(email);
  });

  it("rejects the wrong password with 401", async () => {
    const email = `c3-login-wrong-password-${Date.now()}@example.com`;
    await registerTestUser(email, "correct-horse-battery-staple");

    const response = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "totally-wrong-password" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a nonexistent email with the same 401/INVALID_CREDENTIALS shape (no enumeration)", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({
        email: `c3-does-not-exist-${Date.now()}@example.com`,
        password: "whatever-password",
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });
});
