import express from "express";
import request from "supertest";
import { prisma } from "../src/db/prisma";
import { requireAuth } from "../src/middleware/requireAuth";
import { requireOwnerOrAdmin } from "../src/middleware/requireOwnerOrAdmin";
import { errorMiddleware } from "../src/middleware/errorHandler";
import { signAccessToken } from "../src/auth/jwt";

function buildTestApp() {
  const app = express();
  app.get("/events/:id/owner-or-admin-only", requireAuth, requireOwnerOrAdmin(), (req, res) => {
    res.status(200).json({ ok: true, eventId: req.event?.id });
  });
  app.get(
    "/events/:id/owner-only",
    requireAuth,
    requireOwnerOrAdmin({ allowAdmin: false }),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  app.use(errorMiddleware);
  return app;
}

async function createOrganizerAndEvent() {
  const organizer = await prisma.user.create({
    data: {
      email: `e2-organizer-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "E2 Organizer",
    },
  });
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const event = await prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "E2 Test Event",
      description: "Event used to exercise requireOwnerOrAdmin.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: new Date("2027-05-01T00:00:00.000Z"),
      startTime: new Date("2027-05-01T18:00:00.000Z"),
      endTime: new Date("2027-05-01T21:00:00.000Z"),
      maxCapacity: 50,
    },
  });
  return { organizer, event };
}

async function createUser(role: "USER" | "ADMIN" = "USER") {
  return prisma.user.create({
    data: {
      email: `e2-user-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "E2 Test User",
      role,
    },
  });
}

describe("requireOwnerOrAdmin middleware", () => {
  const app = buildTestApp();

  it("allows the event's owner through", async () => {
    const { organizer, event } = await createOrganizerAndEvent();
    const token = signAccessToken({ sub: organizer.id, role: "USER" });

    const response = await request(app)
      .get(`/events/${event.id}/owner-or-admin-only`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.eventId).toBe(event.id);
  });

  it("returns 403 for a different, non-admin user", async () => {
    const { event } = await createOrganizerAndEvent();
    const otherUser = await createUser();
    const token = signAccessToken({ sub: otherUser.id, role: "USER" });

    const response = await request(app)
      .get(`/events/${event.id}/owner-or-admin-only`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
  });

  it("allows an admin through, even though they're not the owner", async () => {
    const { event } = await createOrganizerAndEvent();
    const admin = await createUser("ADMIN");
    const token = signAccessToken({ sub: admin.id, role: "ADMIN" });

    const response = await request(app)
      .get(`/events/${event.id}/owner-or-admin-only`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
  });

  it("returns 404 for a nonexistent event ID", async () => {
    const someUser = await createUser();
    const token = signAccessToken({ sub: someUser.id, role: "USER" });

    const response = await request(app)
      .get("/events/00000000-0000-0000-0000-000000000000/owner-or-admin-only")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(404);
  });

  it("excludes admin when allowAdmin is false (owner-only mode, per spec §3: admin never edits/cancels another user's event)", async () => {
    const { event } = await createOrganizerAndEvent();
    const admin = await createUser("ADMIN");
    const token = signAccessToken({ sub: admin.id, role: "ADMIN" });

    const response = await request(app)
      .get(`/events/${event.id}/owner-only`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
  });

  it("still allows the actual owner through in owner-only mode", async () => {
    const { organizer, event } = await createOrganizerAndEvent();
    const token = signAccessToken({ sub: organizer.id, role: "USER" });

    const response = await request(app)
      .get(`/events/${event.id}/owner-only`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
  });
});
