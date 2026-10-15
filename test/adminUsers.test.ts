import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";

const app = createApp();
const PASSWORD = "correct-horse-battery-staple";

async function createAdmin() {
  const user = await prisma.user.create({
    data: {
      email: `m-admin-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "M Admin",
      role: "ADMIN",
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role: "ADMIN" }) };
}

async function registerUser(tag = randomUUID(), name = "M User") {
  const email = `m-${tag}@example.com`;
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email, password: PASSWORD, name });
  const cookieLine = (response.headers["set-cookie"] as unknown as string[]).find((entry) =>
    entry.startsWith("refreshToken="),
  )!;
  return {
    id: response.body.user.id as string,
    email,
    token: response.body.accessToken as string,
    refreshCookie: cookieLine.split(";")[0].split("=").slice(1).join("="),
  };
}

const login = (email: string) =>
  request(app).post("/api/auth/login").send({ email, password: PASSWORD });

function authed(call: request.Test, token: string | null) {
  return token ? call.set("Authorization", `Bearer ${token}`) : call;
}
const listUsers = (token: string | null, query = "") =>
  authed(request(app).get(`/api/admin/users${query}`), token);
const suspend = (id: string, token: string | null) =>
  authed(request(app).patch(`/api/admin/users/${id}/suspend`), token);
const reactivate = (id: string, token: string | null) =>
  authed(request(app).patch(`/api/admin/users/${id}/reactivate`), token);

describe("auth on the admin user routes", () => {
  it("returns 401 without a token and 403 for a non-admin on all three, changing nothing", async () => {
    const target = await registerUser();
    const other = await registerUser();

    for (const call of [
      (token: string | null) => listUsers(token),
      (token: string | null) => suspend(target.id, token),
      (token: string | null) => reactivate(target.id, token),
    ]) {
      expect((await call(null)).status).toBe(401);
      expect((await call(other.token)).status).toBe(403);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      "ACTIVE",
    );
  });
});

describe("GET /api/admin/users", () => {
  it("lists users with id, name, email, role, authProvider, status and createdAt — never a password hash", async () => {
    const admin = await createAdmin();
    const tag = randomUUID();
    const user = await registerUser(tag, "Listed Person");

    const response = await listUsers(admin.token, `?search=${tag}`);

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(1);
    expect(response.body.users[0]).toEqual({
      id: user.id,
      name: "Listed Person",
      email: user.email,
      role: "USER",
      authProvider: "LOCAL",
      status: "ACTIVE",
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|hashed-password/);
  });

  it("searches name and email, case-insensitively", async () => {
    const admin = await createAdmin();
    const tag = randomUUID();
    const byEmail = await registerUser(tag, "Plain Name");
    const byName = await registerUser(randomUUID(), `Name ${tag}`);

    const response = await listUsers(admin.token, `?search=${tag.toUpperCase()}`);

    expect(response.body.users.map((row: { id: string }) => row.id).sort()).toEqual(
      [byEmail.id, byName.id].sort(),
    );
  });

  it("filters by status (any letter case)", async () => {
    const admin = await createAdmin();
    const tag = randomUUID();
    const active = await registerUser(`${tag}-a`);
    const suspended = await registerUser(`${tag}-b`);
    await prisma.user.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });

    const onlyActive = await listUsers(admin.token, `?search=${tag}&status=active`);
    const onlySuspended = await listUsers(admin.token, `?search=${tag}&status=SUSPENDED`);
    const both = await listUsers(admin.token, `?search=${tag}`);

    expect(onlyActive.body.users.map((row: { id: string }) => row.id)).toEqual([active.id]);
    expect(onlySuspended.body.users.map((row: { id: string }) => row.id)).toEqual([suspended.id]);
    expect(both.body.users).toHaveLength(2);
  });

  it("rejects an unknown status and an over-long search with 400", async () => {
    const admin = await createAdmin();

    const badStatus = await listUsers(admin.token, "?status=banned");
    const longSearch = await listUsers(admin.token, `?search=${"x".repeat(101)}`);

    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error.details.fields.status).toEqual(expect.any(String));
    expect(longSearch.status).toBe(400);
    expect(longSearch.body.error.details.fields.search).toEqual(expect.any(String));
  });

  it("lists the newest account first", async () => {
    const admin = await createAdmin();
    const tag = randomUUID();
    const older = await registerUser(`${tag}-1`);
    const newer = await registerUser(`${tag}-2`);
    await prisma.user.update({
      where: { id: older.id },
      data: { createdAt: new Date("2001-01-01") },
    });
    await prisma.user.update({
      where: { id: newer.id },
      data: { createdAt: new Date("2001-01-02") },
    });

    const response = await listUsers(admin.token, `?search=${tag}`);

    expect(response.body.users.map((row: { id: string }) => row.id)).toEqual([newer.id, older.id]);
  });

  it("paginates with the same shape as the other lists and rejects bad pagination", async () => {
    const admin = await createAdmin();
    const tag = randomUUID();
    await registerUser(`${tag}-1`);
    await registerUser(`${tag}-2`);

    const page = await listUsers(admin.token, `?search=${tag}&limit=1&page=2`);
    const bad = await listUsers(admin.token, "?page=-1");

    expect(page.status).toBe(200);
    expect(page.body.users).toHaveLength(1);
    expect(page.body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_PAGINATION");
  });
});

describe("PATCH /api/admin/users/:id/suspend", () => {
  it("sets the status to SUSPENDED and returns the user without secrets", async () => {
    const admin = await createAdmin();
    const user = await registerUser();

    const response = await suspend(user.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: user.id, status: "SUSPENDED", role: "USER" });
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe(
      "SUSPENDED",
    );
  });

  it("changes nothing but the status", async () => {
    const admin = await createAdmin();
    const user = await registerUser();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await suspend(user.id, admin.token);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect({ ...after, status: "ACTIVE", updatedAt: before.updatedAt }).toEqual(before);
  });

  it("blocks the user's next login with 403 ACCOUNT_SUSPENDED (finishes C3's stub)", async () => {
    const admin = await createAdmin();
    const user = await registerUser();
    expect((await login(user.email)).status).toBe(200);

    await suspend(user.id, admin.token);

    const response = await login(user.email);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("deletes the user's refresh tokens, so their session can't be renewed — and leaves everyone else's", async () => {
    const admin = await createAdmin();
    const user = await registerUser();
    const bystander = await registerUser();

    await suspend(user.id, admin.token);

    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: bystander.id } })).toBeGreaterThan(0);
    const renewed = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${user.refreshCookie}`);
    expect(renewed.status).toBe(401);
    expect(renewed.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    const bystanderRenewed = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${bystander.refreshCookie}`);
    expect(bystanderRenewed.status).toBe(200);
  });

  it("leaves the user's events and registrations alone", async () => {
    const admin = await createAdmin();
    const organizer = await registerUser();
    const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
    const start = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const event = await prisma.event.create({
      data: {
        organizerId: organizer.id,
        title: "M Event",
        description: "Must survive its organizer's suspension.",
        categoryId: category.id,
        venueName: "Hall",
        address: "1 Test St",
        city: "Testville",
        timezone: "America/New_York",
        date: start,
        startTime: start,
        endTime: new Date(start.getTime() + 3 * 60 * 60 * 1000),
        maxCapacity: 10,
      },
    });

    await suspend(organizer.id, admin.token);

    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after).toEqual(event);
  });

  it("is idempotent", async () => {
    const admin = await createAdmin();
    const user = await registerUser();
    await suspend(user.id, admin.token);

    const again = await suspend(user.id, admin.token);

    expect(again.status).toBe(200);
    expect(again.body.user.status).toBe("SUSPENDED");
  });

  it("refuses to suspend yourself (409 CANNOT_SUSPEND_SELF)", async () => {
    const admin = await createAdmin();

    const response = await suspend(admin.user.id, admin.token);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CANNOT_SUSPEND_SELF");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).status).toBe(
      "ACTIVE",
    );
  });

  it("refuses to suspend another admin (409 CANNOT_SUSPEND_ADMIN)", async () => {
    const admin = await createAdmin();
    const other = await createAdmin();

    const response = await suspend(other.user.id, admin.token);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CANNOT_SUSPEND_ADMIN");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.user.id } })).status).toBe(
      "ACTIVE",
    );
  });

  it("returns 404 for a user that doesn't exist", async () => {
    const admin = await createAdmin();

    expect((await suspend("00000000-0000-0000-0000-000000000000", admin.token)).status).toBe(404);
  });
});

describe("PATCH /api/admin/users/:id/reactivate", () => {
  it("restores the account: a real login works again after reactivation", async () => {
    const admin = await createAdmin();
    const user = await registerUser();
    await suspend(user.id, admin.token);
    expect((await login(user.email)).status).toBe(403);

    const response = await reactivate(user.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: user.id, status: "ACTIVE" });
    const relogin = await login(user.email);
    expect(relogin.status).toBe(200);
    expect(relogin.body.accessToken).toEqual(expect.any(String));
  });

  it("is idempotent for an active user", async () => {
    const admin = await createAdmin();
    const user = await registerUser();

    const response = await reactivate(user.id, admin.token);

    expect(response.status).toBe(200);
    expect(response.body.user.status).toBe("ACTIVE");
  });

  it("returns 404 for a user that doesn't exist", async () => {
    const admin = await createAdmin();

    expect((await reactivate("00000000-0000-0000-0000-000000000000", admin.token)).status).toBe(
      404,
    );
  });
});
