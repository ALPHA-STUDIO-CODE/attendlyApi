import request from "supertest";
import { createApp } from "../src/app";

const app = createApp();

function extractCookieValue(setCookieHeader: string[] | undefined, name: string): string {
  const cookieLine = (setCookieHeader ?? []).find((line) => line.startsWith(`${name}=`));
  if (!cookieLine) {
    throw new Error(
      `Cookie ${name} not found in Set-Cookie header: ${JSON.stringify(setCookieHeader)}`,
    );
  }
  return cookieLine.split(";")[0].split("=").slice(1).join("=");
}

async function registerTestUser(email: string) {
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "correct-horse-battery-staple", name: "C4 Test User" });
  const refreshTokenCookie = extractCookieValue(
    response.headers["set-cookie"] as unknown as string[],
    "refreshToken",
  );
  return { response, refreshTokenCookie };
}

describe("POST /api/auth/refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const { refreshTokenCookie: originalToken } = await registerTestUser(
      `c4-rotate-${Date.now()}@example.com`,
    );

    const refreshResponse = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${originalToken}`);

    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.body.accessToken).toEqual(expect.any(String));

    const newToken = extractCookieValue(
      refreshResponse.headers["set-cookie"] as unknown as string[],
      "refreshToken",
    );
    expect(newToken).not.toBe(originalToken);
  });

  it("rejects a missing refresh token", async () => {
    const response = await request(app).post("/api/auth/refresh");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("MISSING_REFRESH_TOKEN");
  });

  it("rejects an unrecognized refresh token", async () => {
    const response = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", "refreshToken=not-a-real-token");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("detects reuse of an already-rotated token and invalidates every session for that user", async () => {
    const { refreshTokenCookie: originalToken } = await registerTestUser(
      `c4-reuse-${Date.now()}@example.com`,
    );

    // Legitimate first rotation: originalToken -> rotatedToken.
    const firstRefresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${originalToken}`);
    expect(firstRefresh.status).toBe(200);
    const rotatedToken = extractCookieValue(
      firstRefresh.headers["set-cookie"] as unknown as string[],
      "refreshToken",
    );

    // Attacker (or a bug) re-presents the already-rotated-out original token.
    const reuseAttempt = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${originalToken}`);
    expect(reuseAttempt.status).toBe(401);
    expect(reuseAttempt.body.error.code).toBe("REFRESH_TOKEN_REUSE_DETECTED");

    // The legitimately-rotated token must ALSO now be invalid — reuse
    // detection revokes every active session for the user, not just the
    // specific token that was reused. Its row still exists (rotation
    // soft-revokes rather than deletes), so this correctly reads as
    // another reuse-detected event rather than "token never existed" —
    // the row is present, just revoked, same as the original.
    const rotatedTokenNowInvalid = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${rotatedToken}`);
    expect(rotatedTokenNowInvalid.status).toBe(401);
    expect(rotatedTokenNowInvalid.body.error.code).toBe("REFRESH_TOKEN_REUSE_DETECTED");
  });
});

describe("POST /api/auth/logout", () => {
  it("deletes the refresh token row and clears the cookie, invalidating future refresh attempts", async () => {
    const { refreshTokenCookie } = await registerTestUser(`c4-logout-${Date.now()}@example.com`);

    const logoutResponse = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${refreshTokenCookie}`);
    expect(logoutResponse.status).toBe(200);

    const clearedCookieHeader = (logoutResponse.headers["set-cookie"] as unknown as string[]).find(
      (line) => line.startsWith("refreshToken="),
    );
    // clearCookie sends an expired cookie with an empty value.
    expect(clearedCookieHeader).toMatch(/refreshToken=;/);

    const refreshAfterLogout = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${refreshTokenCookie}`);
    expect(refreshAfterLogout.status).toBe(401);
    expect(refreshAfterLogout.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("succeeds even with no refresh token cookie present (idempotent logout)", async () => {
    const response = await request(app).post("/api/auth/logout");
    expect(response.status).toBe(200);
  });
});
