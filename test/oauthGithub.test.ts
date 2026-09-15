import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { exchangeGitHubAuthCode } from "../src/auth/oauth/github";

jest.mock("../src/auth/oauth/github");

const mockedExchange = exchangeGitHubAuthCode as jest.MockedFunction<typeof exchangeGitHubAuthCode>;

const app = createApp();

function fakeGitHubProfile(
  overrides: Partial<{ providerId: string; email: string; name: string }> = {},
) {
  return {
    providerId: `${Math.floor(Math.random() * 1_000_000_000)}`,
    email: `d2-github-${Date.now()}-${Math.random()}@example.com`,
    name: "D2 GitHub User",
    ...overrides,
  };
}

describe("POST /api/auth/oauth/github", () => {
  it("creates a new user on first login, with authProvider GITHUB and no password", async () => {
    const profile = fakeGitHubProfile();
    mockedExchange.mockResolvedValueOnce(profile);

    const response = await request(app).post("/api/auth/oauth/github").send({ code: "fake-code" });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(profile.email);
    expect(response.body.user.authProvider).toBe("GITHUB");
    expect(response.body.accessToken).toEqual(expect.any(String));

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: profile.email } });
    expect(dbUser.passwordHash).toBeNull();
    expect(dbUser.providerId).toBe(profile.providerId);
  });

  it("matches the existing user on a second login with the same providerId, without duplicating", async () => {
    const profile = fakeGitHubProfile();
    mockedExchange.mockResolvedValueOnce(profile);
    const first = await request(app).post("/api/auth/oauth/github").send({ code: "fake-code-1" });
    expect(first.status).toBe(200);
    const firstUserId = first.body.user.id;

    mockedExchange.mockResolvedValueOnce(profile);
    const second = await request(app).post("/api/auth/oauth/github").send({ code: "fake-code-2" });
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(firstUserId);

    const matchingUsers = await prisma.user.findMany({
      where: { providerId: profile.providerId, authProvider: "GITHUB" },
    });
    expect(matchingUsers).toHaveLength(1);
  });

  it("returns the same response shape as local login: user + accessToken + refresh cookie", async () => {
    const profile = fakeGitHubProfile();
    mockedExchange.mockResolvedValueOnce(profile);

    const response = await request(app).post("/api/auth/oauth/github").send({ code: "fake-code" });

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
    const response = await request(app).post("/api/auth/oauth/github").send({});
    expect(response.status).toBe(400);
  });

  it("returns a clean error if the GitHub exchange fails, without leaking why", async () => {
    mockedExchange.mockRejectedValueOnce(
      new Error("GitHub account has no accessible verified email address."),
    );

    const response = await request(app).post("/api/auth/oauth/github").send({ code: "bad-code" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("OAUTH_EXCHANGE_FAILED");
    expect(response.body.error.message).not.toMatch(/verified email/);
  });

  it("rejects with 409 when the email already belongs to a different account", async () => {
    const existingEmail = `d2-collision-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { email: existingEmail, passwordHash: "hashed-password", name: "Existing Local User" },
    });

    mockedExchange.mockResolvedValueOnce(fakeGitHubProfile({ email: existingEmail }));

    const response = await request(app).post("/api/auth/oauth/github").send({ code: "fake-code" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("does not collide with a Google account that has the same providerId string", async () => {
    // providerId uniqueness is scoped to (authProvider, providerId), not
    // providerId alone — a numeric GitHub id could coincidentally match a
    // Google `sub` string. Confirms findOrCreateOAuthUser's query filters
    // on both fields, not just providerId.
    const sharedId = "12345";
    await prisma.user.create({
      data: {
        email: `d2-google-sibling-${Date.now()}@example.com`,
        name: "Google Sibling",
        authProvider: "GOOGLE",
        providerId: sharedId,
        passwordHash: null,
      },
    });

    mockedExchange.mockResolvedValueOnce(fakeGitHubProfile({ providerId: sharedId }));

    const response = await request(app).post("/api/auth/oauth/github").send({ code: "fake-code" });

    expect(response.status).toBe(200);
    expect(response.body.user.authProvider).toBe("GITHUB");
  });
});
