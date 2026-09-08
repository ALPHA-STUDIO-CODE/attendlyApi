import { prisma } from "../src/db/prisma";
import { Role, AuthProvider, UserStatus } from "@prisma/client";

describe("User model", () => {
  it("creates a user with default role/authProvider/status", async () => {
    const user = await prisma.user.create({
      data: {
        email: "b1-create@example.com",
        passwordHash: "hashed-password",
        name: "B1 Test User",
      },
    });

    expect(user.id).toEqual(expect.any(String));
    expect(user.role).toBe(Role.USER);
    expect(user.authProvider).toBe(AuthProvider.LOCAL);
    expect(user.status).toBe(UserStatus.ACTIVE);
  });

  it("rejects a duplicate email with a unique-constraint error", async () => {
    await prisma.user.create({
      data: {
        email: "b1-duplicate@example.com",
        passwordHash: "hashed-password",
        name: "First User",
      },
    });

    await expect(
      prisma.user.create({
        data: {
          email: "b1-duplicate@example.com",
          passwordHash: "another-hash",
          name: "Second User",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("RefreshToken model", () => {
  it("creates a refresh token row referencing a user", async () => {
    const user = await prisma.user.create({
      data: {
        email: "b1-refresh-token@example.com",
        passwordHash: "hashed-password",
        name: "Refresh Token Owner",
      },
    });

    const refreshToken = await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: "sha256-of-some-token",
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
      },
    });

    expect(refreshToken.userId).toBe(user.id);

    const found = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: refreshToken.id },
      include: { user: true },
    });
    expect(found.user.email).toBe("b1-refresh-token@example.com");
  });
});
