import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";

const app = createApp();

async function createOrganizer() {
  return prisma.user.create({
    data: {
      email: `f3-organizer-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "F3 Organizer",
    },
  });
}

async function createEvent(overrides: Record<string, unknown> = {}) {
  const organizer = await createOrganizer();
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "F3 Test Event",
      description: "An event used to exercise GET /api/events filters.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: 50,
      ...overrides,
    },
  });
}

describe("GET /api/events", () => {
  it("returns events with default pagination (page 1, limit 20)", async () => {
    await createEvent();
    const response = await request(app).get("/api/events");
    expect(response.status).toBe(200);
    expect(response.body.pagination.page).toBe(1);
    expect(response.body.pagination.limit).toBe(20);
    expect(Array.isArray(response.body.events)).toBe(true);
  });

  it("filters by city", async () => {
    const uniqueCity = `F3City${Date.now()}`;
    await createEvent({ city: uniqueCity });
    await createEvent({ city: "SomewhereElse" });

    const response = await request(app).get("/api/events").query({ city: uniqueCity });
    expect(response.status).toBe(200);
    expect(response.body.events.length).toBeGreaterThan(0);
    for (const event of response.body.events) {
      expect(event.city).toBe(uniqueCity);
    }
  });

  it("filters by search across title", async () => {
    const uniqueTitle = `F3UniqueSearchTitle${Date.now()}`;
    await createEvent({ title: uniqueTitle });

    const response = await request(app).get("/api/events").query({ search: uniqueTitle });
    expect(response.status).toBe(200);
    expect(response.body.events.some((e: { title: string }) => e.title === uniqueTitle)).toBe(true);
  });

  it("rejects non-numeric pagination with 400 (the 'wildly invalid' branch, not silent clamping)", async () => {
    const response = await request(app).get("/api/events").query({ page: "not-a-number" });
    // Non-numeric is "wildly invalid" per spec §8.5 -> 400, not silently
    // clamped — confirming this matches parsePagination's own unit tests.
    expect(response.status).toBe(400);
  });

  it("filters by category", async () => {
    const tech = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
    const music = await prisma.category.findFirstOrThrow({ where: { name: "Music" } });
    const techEvent = await createEvent({ categoryId: tech.id, title: `F3TechEvent${Date.now()}` });
    await createEvent({ categoryId: music.id, title: `F3MusicEvent${Date.now()}` });

    const response = await request(app).get("/api/events").query({ category: tech.id });
    expect(response.status).toBe(200);
    const ids = response.body.events.map((e: { id: string }) => e.id);
    expect(ids).toContain(techEvent.id);
    for (const event of response.body.events) {
      expect(event.categoryId).toBe(tech.id);
    }
  });

  it("upcoming=true excludes events whose date has already passed", async () => {
    const pastTitle = `F3PastEvent${Date.now()}`;
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    await createEvent({
      title: pastTitle,
      date: pastDate,
      startTime: pastDate,
      endTime: new Date(pastDate.getTime() + 1000 * 60 * 60),
    });
    const futureTitle = `F3FutureEvent${Date.now()}`;
    await createEvent({ title: futureTitle });

    const response = await request(app).get("/api/events").query({ upcoming: "true" });
    expect(response.status).toBe(200);
    const titles = response.body.events.map((e: { title: string }) => e.title);
    expect(titles).not.toContain(pastTitle);
    expect(titles).toContain(futureTitle);
  });

  it("caps limit at the max page size even if a larger one is requested", async () => {
    const response = await request(app).get("/api/events").query({ limit: "99999" });
    expect(response.status).toBe(200);
    expect(response.body.pagination.limit).toBe(100);
  });

  it("still shows CANCELLED events in listings, per spec §7.6", async () => {
    const event = await createEvent({ status: "CANCELLED" });
    const response = await request(app).get("/api/events").query({ search: event.title });
    const found = response.body.events.find((e: { id: string }) => e.id === event.id);
    expect(found).toBeDefined();
    expect(found.status).toBe("CANCELLED");
  });
});
