import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";

const app = createApp();

async function createUserToken() {
  const response = await request(app)
    .post("/api/auth/register")
    .send({
      email: `f2-user-${Date.now()}-${Math.random()}@example.com`,
      password: "correct-horse-battery-staple",
      name: "F2 Test User",
    });
  return response.body.accessToken as string;
}

async function getSeededCategoryId(): Promise<string> {
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  return category.id;
}

function validEventPayload(categoryId: string, overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const end = new Date(start.getTime() + 1000 * 60 * 60 * 3);
  return {
    title: "F2 Test Conference",
    description: "A test event created for F2 verification.",
    categoryId,
    customTags: ["testing"],
    venueName: "Test Hall",
    address: "123 Test St",
    city: "Testville",
    timezone: "America/New_York",
    date: start.toISOString(),
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    maxCapacity: 100,
    ...overrides,
  };
}

describe("POST /api/events", () => {
  it("creates an event with a valid payload, organizer set to the requester", async () => {
    const token = await createUserToken();
    const categoryId = await getSeededCategoryId();

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(validEventPayload(categoryId));

    expect(response.status).toBe(201);
    expect(response.body.event.title).toBe("F2 Test Conference");
    expect(response.body.event.status).toBe("PUBLISHED");
    expect(response.body.event.isLocked).toBe(false);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const categoryId = await getSeededCategoryId();
    const response = await request(app).post("/api/events").send(validEventPayload(categoryId));
    expect(response.status).toBe(401);
  });

  it("rejects a missing required field with 400", async () => {
    const token = await createUserToken();
    const categoryId = await getSeededCategoryId();
    const payload = validEventPayload(categoryId);
    delete (payload as Record<string, unknown>).title;

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(payload);
    expect(response.status).toBe(400);
    expect(response.body.error.details.fields.title).toBeDefined();
  });

  it("rejects endTime before startTime with 422", async () => {
    const token = await createUserToken();
    const categoryId = await getSeededCategoryId();
    const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    const beforeStart = new Date(start.getTime() - 1000 * 60 * 60);

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(
        validEventPayload(categoryId, {
          startTime: start.toISOString(),
          endTime: beforeStart.toISOString(),
        }),
      );
    expect(response.status).toBe(422);
    expect(response.body.error.details.fields.endTime).toBeDefined();
  });

  it("rejects zero capacity with 422", async () => {
    const token = await createUserToken();
    const categoryId = await getSeededCategoryId();

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(validEventPayload(categoryId, { maxCapacity: 0 }));
    expect(response.status).toBe(422);
  });

  it("rejects a date in the past with 422", async () => {
    const token = await createUserToken();
    const categoryId = await getSeededCategoryId();

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(validEventPayload(categoryId, { date: new Date(Date.now() - 86400000).toISOString() }));
    expect(response.status).toBe(422);
  });

  it("rejects an invalid timezone with 422", async () => {
    const token = await createUserToken();
    const categoryId = await getSeededCategoryId();

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(validEventPayload(categoryId, { timezone: "Not/A_Real_Zone" }));
    expect(response.status).toBe(422);
  });

  it("rejects a nonexistent categoryId with 400", async () => {
    const token = await createUserToken();

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(validEventPayload("00000000-0000-0000-0000-000000000000"));
    expect(response.status).toBe(400);
    expect(response.body.error.details.fields.categoryId).toBeDefined();
  });
});
