import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { exchangeGoogleAuthCode } from "../src/auth/oauth/google";

jest.mock("../src/auth/oauth/google");

const mockedExchange = exchangeGoogleAuthCode as jest.MockedFunction<typeof exchangeGoogleAuthCode>;

const app = createApp();

function fakeGoogleProfile(
  overrides: Partial<{ providerId: string; email: string; name: string }> = {},
) {
  return {
    providerId: `google-sub-${Date.now()}-${Math.random()}`,
    email: `d1-google-${Date.now()}-${Math.random()}@example.com`,
    name: "D1 Google User",
    ...overrides,
  };
}

describe("POST /api/auth/oauth/google", () => {
  it("creates a new user on first login, with authProvider GOOGLE and no password", async () => {
    const profile = fakeGoogleProfile();
    mockedExchange.mockResolvedValueOnce(profile);

    const response = await request(app).post("/api/auth/oauth/google").send({ code: "fake-code" });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(profile.email);
    expect(response.body.user.authProvider).toBe("GOOGLE");
    expect(response.body.accessToken).toEqual(expect.any(String));

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: profile.email } });
    expect(dbUser.passwordHash).toBeNull();
    expect(dbUser.providerId).toBe(profile.providerId);
  });

  it("matches the existing user on a second login with the same providerId, without duplicating", async () => {
    const profile = fakeGoogleProfile();
    mockedExchange.mockResolvedValueOnce(profile);
    const first = await request(app).post("/api/auth/oauth/google").send({ code: "fake-code-1" });
    expect(first.status).toBe(200);
    const firstUserId = first.body.user.id;

    mockedExchange.mockResolvedValueOnce(profile);
    const second = await request(app).post("/api/auth/oauth/google").send({ code: "fake-code-2" });
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(firstUserId);

    const matchingUsers = await prisma.user.findMany({ where: { providerId: profile.providerId } });
    expect(matchingUsers).toHaveLength(1);
  });

  it("returns the same response shape as local login: user + accessToken + refresh cookie", async () => {
    const profile = fakeGoogleProfile();
    mockedExchange.mockResolvedValueOnce(profile);

    const response = await request(app).post("/api/auth/oauth/google").send({ code: "fake-code" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ id: expect.any(String), email: profile.email }),
        accessToken: expect.any(String),
      }),
    );
    const setCookieHeader = response.headers["set-cookie"] as unknown as string[];
    expect(setCookieHeader.some((line) => line.startsWith("refreshToken="))).toBe(true);
  });

  it("rejects a request with no authorization code", async () => {
    const response = await request(app).post("/api/auth/oauth/google").send({});
    expect(response.status).toBe(400);
  });

  it("returns a clean error if the Google exchange fails, without leaking why", async () => {
    mockedExchange.mockRejectedValueOnce(new Error("Google said no."));

    const response = await request(app).post("/api/auth/oauth/google").send({ code: "bad-code" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("OAUTH_EXCHANGE_FAILED");
    expect(response.body.error.message).not.toMatch(/Google said no/);
  });

  it("rejects with 409 when the email already belongs to a different account", async () => {
    const existingEmail = `d1-collision-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { email: existingEmail, passwordHash: "hashed-password", name: "Existing Local User" },
    });

    mockedExchange.mockResolvedValueOnce(fakeGoogleProfile({ email: existingEmail }));

    const response = await request(app).post("/api/auth/oauth/google").send({ code: "fake-code" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EMAIL_TAKEN");
  });
});
