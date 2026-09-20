import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";

const app = createApp();

async function createUserWithToken() {
  const email = `f5-user-${Date.now()}-${Math.random()}@example.com`;
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "correct-horse-battery-staple", name: "F5 Test User" });
  return { userId: response.body.user.id as string, token: response.body.accessToken as string };
}

async function createEventForOrganizer(
  organizerId: string,
  overrides: Record<string, unknown> = {},
) {
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Business" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId,
      title: "F5 Original Title",
      description: "Original description.",
      categoryId: category.id,
      venueName: "Original Hall",
      address: "123 Original St",
      city: "Originalville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: 50,
      ...overrides,
    },
  });
}

describe("PATCH /api/events/:id", () => {
  it("lets the owner edit an unlocked event, all changed fields updated", async () => {
    const { userId, token } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);

    const response = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "F5 Updated Title", city: "Updatedville" });

    expect(response.status).toBe(200);
    expect(response.body.event.title).toBe("F5 Updated Title");
    expect(response.body.event.city).toBe("Updatedville");
  });

  it("rejects a non-owner with 403", async () => {
    const { userId } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);
    const { token: otherToken } = await createUserWithToken();

    const response = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ title: "Hijacked Title" });

    expect(response.status).toBe(403);
  });

  it("rejects editing a locked field on a locked event with 409 EVENT_LOCKED", async () => {
    const { userId, token } = await createUserWithToken();
    const event = await createEventForOrganizer(userId, { isLocked: true });

    const response = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ city: "ShouldBeRejected" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EVENT_LOCKED");
    expect(response.body.error.details.lockedFields).toContain("city");
  });

  it("still allows editing unlocked-category fields on a locked event", async () => {
    const { userId, token } = await createUserWithToken();
    const event = await createEventForOrganizer(userId, { isLocked: true });

    const response = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "F5 Still Editable Title", customTags: ["updated-tag"] });

    expect(response.status).toBe(200);
    expect(response.body.event.title).toBe("F5 Still Editable Title");
    expect(response.body.event.customTags).toEqual(["updated-tag"]);
  });

  it("returns 422 if an edit introduces a semantic problem (endTime before the existing startTime)", async () => {
    const { userId, token } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);
    const earlierThanStart = new Date(event.startTime.getTime() - 1000 * 60 * 60);

    const response = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ endTime: earlierThanStart.toISOString() });

    expect(response.status).toBe(422);
  });

  it("does not reject an unrelated edit just because the event's (unchanged) date has since passed", async () => {
    // Simulates an event whose date has drifted into the past since
    // creation — can't happen via the API (creation requires a future
    // date), but is a completely normal real-world state for an event
    // that's simply already happened. Seeded directly to isolate this
    // from event-creation's own validation.
    const { userId, token } = await createUserWithToken();
    const event = await createEventForOrganizer(userId, {
      date: new Date(Date.now() - 1000 * 60 * 60 * 24),
    });

    const response = await request(app)
      .patch(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Updated description, unrelated to the date." });

    expect(response.status).toBe(200);
    expect(response.body.event.description).toBe("Updated description, unrelated to the date.");
  });

  it("returns 404 for a nonexistent event", async () => {
    const { token } = await createUserWithToken();
    const response = await request(app)
      .patch("/api/events/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Doesn't Matter" });
    expect(response.status).toBe(404);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const { userId } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);
    const response = await request(app).patch(`/api/events/${event.id}`).send({ title: "Nope" });
    expect(response.status).toBe(401);
  });
});
