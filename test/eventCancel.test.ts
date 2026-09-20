import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import * as cancellationEmail from "../src/email/queueCancellationEmails";

const app = createApp();

async function createUserWithToken() {
  const email = `f6-user-${Date.now()}-${Math.random()}@example.com`;
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "correct-horse-battery-staple", name: "F6 Test User" });
  return { userId: response.body.user.id as string, token: response.body.accessToken as string };
}

async function createEventForOrganizer(organizerId: string) {
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Sports" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId,
      title: "F6 Test Event",
      description: "An event used to exercise DELETE /api/events/:id.",
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

describe("DELETE /api/events/:id", () => {
  it("lets the owner soft-cancel their event; it stays fetchable with status CANCELLED", async () => {
    const { userId, token } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);

    const cancelResponse = await request(app)
      .delete(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.event.status).toBe("CANCELLED");

    const getResponse = await request(app).get(`/api/events/${event.id}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.event.status).toBe("CANCELLED");
  });

  it("triggers the cancellation-email seam with the cancelled event's id", async () => {
    const spy = jest.spyOn(cancellationEmail, "queueCancellationEmails");
    const { userId, token } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);

    const response = await request(app)
      .delete(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(event.id);
    spy.mockRestore();
  });

  it("rejects a non-owner with 403", async () => {
    const { userId } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);
    const { token: otherToken } = await createUserWithToken();

    const response = await request(app)
      .delete(`/api/events/${event.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(response.status).toBe(403);
  });

  it("returns 404 for a nonexistent event", async () => {
    const { token } = await createUserWithToken();
    const response = await request(app)
      .delete("/api/events/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(404);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const { userId } = await createUserWithToken();
    const event = await createEventForOrganizer(userId);
    const response = await request(app).delete(`/api/events/${event.id}`);
    expect(response.status).toBe(401);
  });
});
