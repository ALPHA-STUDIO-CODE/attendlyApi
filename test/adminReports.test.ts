import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";

const app = createApp();

async function createUser(role: "USER" | "ADMIN" = "USER", label = "user") {
  const user = await prisma.user.create({
    data: {
      email: `l2-${label}-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: `L2 ${label}`,
      role,
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role }) };
}

async function createEvent() {
  const { user: organizer } = await createUser("USER", "organizer");
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "L2 Reported Event",
      description: "An event used to exercise the admin report queue.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: 50,
    },
  });
}

async function createReport(
  overrides: {
    eventId?: string;
    reporterId?: string;
    status?: "OPEN" | "REVIEWED" | "DISMISSED";
    createdAt?: Date;
    reason?: string;
  } = {},
) {
  const eventId = overrides.eventId ?? (await createEvent()).id;
  const reporterId = overrides.reporterId ?? (await createUser("USER", "reporter")).user.id;
  return prisma.report.create({
    data: {
      eventId,
      reporterId,
      reason: overrides.reason ?? "L2 reason",
      status: overrides.status ?? "OPEN",
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

function listReports(token: string | null, query = "") {
  const call = request(app).get(`/api/admin/reports${query}`);
  return token ? call.set("Authorization", `Bearer ${token}`) : call;
}

function patchReport(id: string, token: string | null, body: unknown) {
  const call = request(app).patch(`/api/admin/reports/${id}`);
  return (token ? call.set("Authorization", `Bearer ${token}`) : call).send(body as object);
}

function idsOf(body: { reports: { id: string }[] }): string[] {
  return body.reports.map((report) => report.id);
}

describe("GET /api/admin/reports", () => {
  it("returns 401 without a token and 403 for a non-admin", async () => {
    const { token } = await createUser("USER", "plain");

    expect((await listReports(null)).status).toBe(401);
    expect((await listReports(token)).status).toBe(403);
  });

  it("lists reports with the reporter and a summary of the reported event", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const reporter = await createUser("USER", "reporter");
    const event = await createEvent();
    const report = await createReport({
      eventId: event.id,
      reporterId: reporter.user.id,
      reason: "Fake venue.",
    });

    const response = await listReports(token, "?limit=100");

    expect(response.status).toBe(200);
    const found = response.body.reports.find((row: { id: string }) => row.id === report.id);
    expect(found).toMatchObject({
      id: report.id,
      reason: "Fake venue.",
      status: "OPEN",
      reporter: { id: reporter.user.id, name: "L2 reporter", email: reporter.user.email },
      event: {
        id: event.id,
        title: "L2 Reported Event",
        status: "PUBLISHED",
        deletedAt: null,
        organizerId: event.organizerId,
      },
    });
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 100 });
  });

  it("filters by status (?status=open, any letter case) and excludes the others", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const open = await createReport({ status: "OPEN" });
    const reviewed = await createReport({ status: "REVIEWED" });
    const dismissed = await createReport({ status: "DISMISSED" });

    for (const query of ["?status=open", "?status=OPEN"]) {
      const response = await listReports(token, `${query}&limit=100`);
      expect(response.status).toBe(200);
      expect(idsOf(response.body)).toContain(open.id);
      expect(idsOf(response.body)).not.toContain(reviewed.id);
      expect(idsOf(response.body)).not.toContain(dismissed.id);
      for (const row of response.body.reports) {
        expect(row.status).toBe("OPEN");
      }
    }

    const reviewedOnly = await listReports(token, "?status=reviewed&limit=100");
    expect(idsOf(reviewedOnly.body)).toContain(reviewed.id);
    expect(idsOf(reviewedOnly.body)).not.toContain(open.id);
  });

  it("returns every status when no filter is given", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const open = await createReport({ status: "OPEN" });
    const dismissed = await createReport({ status: "DISMISSED" });

    const response = await listReports(token, "?limit=100");

    expect(idsOf(response.body)).toEqual(expect.arrayContaining([open.id, dismissed.id]));
  });

  it("rejects an unknown status with 400", async () => {
    const { token } = await createUser("ADMIN", "admin");

    const response = await listReports(token, "?status=pending");

    expect(response.status).toBe(400);
    expect(response.body.error.details.fields.status).toEqual(expect.any(String));
  });

  it("lists the oldest report first", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const newer = await createReport({ createdAt: new Date("2001-01-02T00:00:00.000Z") });
    const older = await createReport({ createdAt: new Date("2001-01-01T00:00:00.000Z") });

    const response = await listReports(token, "?status=open&limit=100");

    const ids = idsOf(response.body);
    expect(ids.indexOf(older.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });

  it("paginates with the same shape as the other lists", async () => {
    const { token } = await createUser("ADMIN", "admin");
    await createReport();
    await createReport();

    const response = await listReports(token, "?limit=1&page=2");

    expect(response.status).toBe(200);
    expect(response.body.reports).toHaveLength(1);
    expect(response.body.pagination.page).toBe(2);
    expect(response.body.pagination.limit).toBe(1);
    expect(response.body.pagination.total).toBeGreaterThanOrEqual(2);
    expect(response.body.pagination.totalPages).toBe(response.body.pagination.total);
  });

  it("rejects wildly invalid pagination with 400", async () => {
    const { token } = await createUser("ADMIN", "admin");

    const response = await listReports(token, "?page=-1");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_PAGINATION");
  });

  it("still lists a report whose event an admin has since removed, marked with deletedAt", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const report = await createReport();
    await prisma.event.update({ where: { id: report.eventId }, data: { deletedAt: new Date() } });

    const response = await listReports(token, "?limit=100");

    const found = response.body.reports.find((row: { id: string }) => row.id === report.id);
    expect(found.event.deletedAt).not.toBeNull();
  });
});

describe("PATCH /api/admin/reports/:id", () => {
  it("returns 401 without a token and 403 for a non-admin, changing nothing", async () => {
    const { token } = await createUser("USER", "plain");
    const report = await createReport();

    expect((await patchReport(report.id, null, { status: "DISMISSED" })).status).toBe(401);
    expect((await patchReport(report.id, token, { status: "DISMISSED" })).status).toBe(403);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(
      "OPEN",
    );
  });

  it.each(["REVIEWED", "DISMISSED"] as const)("sets the status to %s (200)", async (status) => {
    const { token } = await createUser("ADMIN", "admin");
    const report = await createReport();

    const response = await patchReport(report.id, token, { status });

    expect(response.status).toBe(200);
    expect(response.body.report).toMatchObject({ id: report.id, status });
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(
      status,
    );
  });

  it("accepts a lowercase status", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const report = await createReport();

    const response = await patchReport(report.id, token, { status: "dismissed" });

    expect(response.status).toBe(200);
    expect(response.body.report.status).toBe("DISMISSED");
  });

  it("can reopen a report", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const report = await createReport({ status: "DISMISSED" });

    const response = await patchReport(report.id, token, { status: "OPEN" });

    expect(response.status).toBe(200);
    expect(response.body.report.status).toBe("OPEN");
  });

  it("drops the report from the open queue once it is reviewed", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const report = await createReport();
    expect(idsOf((await listReports(token, "?status=open&limit=100")).body)).toContain(report.id);

    await patchReport(report.id, token, { status: "REVIEWED" });

    expect(idsOf((await listReports(token, "?status=open&limit=100")).body)).not.toContain(
      report.id,
    );
  });

  it.each([
    ["a missing status", {}],
    ["an unknown status", { status: "DELETED" }],
    ["a non-string status", { status: 3 }],
  ])("returns 400 for %s", async (_label, body) => {
    const { token } = await createUser("ADMIN", "admin");
    const report = await createReport();

    const response = await patchReport(report.id, token, body);

    expect(response.status).toBe(400);
    expect(response.body.error.details.fields.status).toEqual(expect.any(String));
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(
      "OPEN",
    );
  });

  it("returns 404 for a report that doesn't exist", async () => {
    const { token } = await createUser("ADMIN", "admin");

    const response = await patchReport("00000000-0000-0000-0000-000000000000", token, {
      status: "REVIEWED",
    });

    expect(response.status).toBe(404);
  });

  it("changes only the report, never the reported event", async () => {
    const { token } = await createUser("ADMIN", "admin");
    const report = await createReport();
    const before = await prisma.event.findUniqueOrThrow({ where: { id: report.eventId } });

    await patchReport(report.id, token, { status: "DISMISSED" });

    expect(await prisma.event.findUniqueOrThrow({ where: { id: report.eventId } })).toEqual(before);
  });
});
