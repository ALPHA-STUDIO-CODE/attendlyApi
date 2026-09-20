import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";

const app = createApp();

describe("GET /api/events/:id", () => {
  it("returns the full event detail including category and public organizer info", async () => {
    const organizer = await prisma.user.create({
      data: {
        email: `f4-organizer-${Date.now()}@example.com`,
        passwordHash: "hashed-password",
        name: "F4 Organizer",
      },
    });
    const category = await prisma.category.findFirstOrThrow({ where: { name: "Music" } });
    const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    const event = await prisma.event.create({
      data: {
        organizerId: organizer.id,
        title: "F4 Test Event",
        description: "An event used to exercise GET /api/events/:id.",
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

    const response = await request(app).get(`/api/events/${event.id}`);

    expect(response.status).toBe(200);
    expect(response.body.event.id).toBe(event.id);
    expect(response.body.event.category.name).toBe("Music");
    expect(response.body.event.organizer.id).toBe(organizer.id);
    expect(response.body.event.organizer.name).toBe("F4 Organizer");
    // Public detail endpoint — organizer email must never be exposed here.
    expect(response.body.event.organizer.email).toBeUndefined();
  });

  it("returns 404 for a nonexistent event ID", async () => {
    const response = await request(app).get("/api/events/00000000-0000-0000-0000-000000000000");
    expect(response.status).toBe(404);
  });

  it("requires no authentication", async () => {
    const response = await request(app).get("/api/events/00000000-0000-0000-0000-000000000000");
    expect(response.status).not.toBe(401);
  });
});
