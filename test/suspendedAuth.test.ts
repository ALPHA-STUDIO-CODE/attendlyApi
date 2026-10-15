import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { exchangeGoogleAuthCode } from "../src/auth/oauth/google";
import { exchangeGitHubAuthCode } from "../src/auth/oauth/github";

jest.mock("../src/auth/oauth/google");
jest.mock("../src/auth/oauth/github");

const mockedGoogle = exchangeGoogleAuthCode as jest.MockedFunction<typeof exchangeGoogleAuthCode>;
const mockedGitHub = exchangeGitHubAuthCode as jest.MockedFunction<typeof exchangeGitHubAuthCode>;

const app = createApp();

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const line = (setCookie ?? []).find((entry) => entry.startsWith(`${name}=`));
  return line?.split(";")[0].split("=").slice(1).join("=");
}

describe("suspended users can't get a session", () => {
  it.each([
    ["Google", mockedGoogle, "/api/auth/oauth/google", "GOOGLE"],
    ["GitHub", mockedGitHub, "/api/auth/oauth/github", "GITHUB"],
  ] as const)(
    "%s login → 403 ACCOUNT_SUSPENDED, no tokens issued",
    async (_name, mocked, path, provider) => {
      const providerId = `m-${provider}-${Date.now()}-${Math.random()}`;
      const user = await prisma.user.create({
        data: {
          email: `m-${provider.toLowerCase()}-${Date.now()}-${Math.random()}@example.com`,
          name: "M Suspended OAuth",
          authProvider: provider,
          providerId,
          status: "SUSPENDED",
        },
      });
      mocked.mockResolvedValueOnce({ providerId, email: user.email, name: user.name });

      const response = await request(app).post(path).send({ code: "fake-code" });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("ACCOUNT_SUSPENDED");
      expect(response.body.accessToken).toBeUndefined();
      expect(
        cookieValue(response.headers["set-cookie"] as unknown as string[], "refreshToken"),
      ).toBeUndefined();
      expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    },
  );

  it("refresh with a still-valid cookie → 403 ACCOUNT_SUSPENDED, cookie cleared, tokens deleted", async () => {
    const register = await request(app)
      .post("/api/auth/register")
      .send({
        email: `m-refresh-${Date.now()}-${Math.random()}@example.com`,
        password: "correct-horse-battery-staple",
        name: "M Refresh",
      });
    const cookie = cookieValue(
      register.headers["set-cookie"] as unknown as string[],
      "refreshToken",
    );
    const userId = register.body.user.id as string;
    await prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });

    const response = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${cookie}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect(response.body.accessToken).toBeUndefined();
    const cleared = (response.headers["set-cookie"] as unknown as string[]).find((entry) =>
      entry.startsWith("refreshToken=;"),
    );
    expect(cleared).toBeDefined();
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);
  });
});
