import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { signAccessToken } from "../src/auth/jwt";
import * as confirmationEmail from "../src/email/queueRegistrationConfirmationEmail";

const app = createApp();

async function createUser() {
  const user = await prisma.user.create({
    data: {
      email: `h3-user-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "H3 Test User",
    },
  });
  return { user, token: signAccessToken({ sub: user.id, role: "USER" }) };
}

async function createEvent(
  overrides: { maxCapacity?: number; status?: "PUBLISHED" | "CANCELLED" | "FLAGGED" } = {},
) {
  const { user: organizer } = await createUser();
  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });
  const start = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "H3 Test Event",
      description: "An event used to exercise DELETE /api/events/:id/register.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: start,
      startTime: start,
      endTime: new Date(start.getTime() + 1000 * 60 * 60 * 3),
      maxCapacity: overrides.maxCapacity ?? 50,
      status: overrides.status ?? "PUBLISHED",
    },
  });
}

function register(eventId: string, token: string) {
  return request(app)
    .post(`/api/events/${eventId}/register`)
    .set("Authorization", `Bearer ${token}`);
}

function cancel(eventId: string, token: string) {
  return request(app)
    .delete(`/api/events/${eventId}/register`)
    .set("Authorization", `Bearer ${token}`);
}

/** Registers `count` fresh users one at a time so order (and positions) are deterministic. */
async function registerUsersInOrder(eventId: string, count: number) {
  const users: Array<{ userId: string; token: string }> = [];
  for (let i = 0; i < count; i++) {
    const { user, token } = await createUser();
    await register(eventId, token);
    users.push({ userId: user.id, token });
  }
  return users;
}

function findRegistration(eventId: string, userId: string) {
  return prisma.registration.findUniqueOrThrow({
    where: { eventId_userId: { eventId, userId } },
  });
}

describe("DELETE /api/events/:id/register", () => {
  let emailSpy: jest.SpyInstance;

  beforeEach(() => {
    emailSpy = jest.spyOn(confirmationEmail, "queueRegistrationConfirmationEmail");
  });

  afterEach(() => {
    emailSpy.mockRestore();
  });

  describe("cancelling a REGISTERED row with a waitlist (spec §7.2)", () => {
    it("marks the row CANCELLED and promotes the lowest-position waitlisted user", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [seated, waitlist1, waitlist2] = await registerUsersInOrder(event.id, 3);

      const response = await cancel(event.id, seated.token);

      expect(response.status).toBe(200);
      expect(response.body.registration.status).toBe("CANCELLED");

      expect((await findRegistration(event.id, seated.userId)).status).toBe("CANCELLED");

      const promoted = await findRegistration(event.id, waitlist1.userId);
      expect(promoted.status).toBe("REGISTERED");
      expect(promoted.waitlistPosition).toBeNull();

      // The next person in line is untouched apart from moving up.
      const stillWaiting = await findRegistration(event.id, waitlist2.userId);
      expect(stillWaiting.status).toBe("WAITLISTED");
    });

    it("keeps the remaining waitlist positions sequential from 1 (assumption: not in spec)", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [seated, , w2, w3] = await registerUsersInOrder(event.id, 4);

      await cancel(event.id, seated.token);

      expect((await findRegistration(event.id, w2.userId)).waitlistPosition).toBe(1);
      expect((await findRegistration(event.id, w3.userId)).waitlistPosition).toBe(2);
    });

    it("queues a confirmation email for the promoted user, flagged as a waitlist promotion", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [seated, waitlist1] = await registerUsersInOrder(event.id, 2);
      emailSpy.mockClear(); // ignore the confirmations queued while registering

      await cancel(event.id, seated.token);

      const promotedRegistration = await findRegistration(event.id, waitlist1.userId);
      expect(emailSpy).toHaveBeenCalledTimes(1);
      expect(emailSpy).toHaveBeenCalledWith(promotedRegistration.id, {
        promotedFromWaitlist: true,
      });
    });

    it("never exceeds capacity after promotion", async () => {
      const event = await createEvent({ maxCapacity: 2 });
      const users = await registerUsersInOrder(event.id, 4);

      await cancel(event.id, users[0].token);

      const registeredCount = await prisma.registration.count({
        where: { eventId: event.id, status: "REGISTERED" },
      });
      expect(registeredCount).toBe(2);
    });
  });

  describe("cancelling a REGISTERED row with an empty waitlist", () => {
    it("just marks the row CANCELLED — no promotion, no email, no error", async () => {
      const event = await createEvent({ maxCapacity: 5 });
      const [only] = await registerUsersInOrder(event.id, 1);
      emailSpy.mockClear();

      const response = await cancel(event.id, only.token);

      expect(response.status).toBe(200);
      expect(response.body.registration.status).toBe("CANCELLED");
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it("frees the seat for a later registrant", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [seated] = await registerUsersInOrder(event.id, 1);
      await cancel(event.id, seated.token);
      const { token } = await createUser();

      const response = await register(event.id, token);

      expect(response.body.registration.status).toBe("REGISTERED");
    });
  });

  describe("cancelling a WAITLISTED row", () => {
    it("marks it CANCELLED without promoting anyone or queuing an email", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [seated, waitlist1, waitlist2] = await registerUsersInOrder(event.id, 3);
      emailSpy.mockClear();

      const response = await cancel(event.id, waitlist1.token);

      expect(response.status).toBe(200);
      expect(response.body.registration.status).toBe("CANCELLED");
      expect(response.body.registration.waitlistPosition).toBeNull();
      expect((await findRegistration(event.id, seated.userId)).status).toBe("REGISTERED");
      expect((await findRegistration(event.id, waitlist2.userId)).status).toBe("WAITLISTED");
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it("closes the gap: everyone behind moves up one position", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [, w1, w2, w3, w4] = await registerUsersInOrder(event.id, 5);

      await cancel(event.id, w2.token);

      expect((await findRegistration(event.id, w1.userId)).waitlistPosition).toBe(1);
      expect((await findRegistration(event.id, w3.userId)).waitlistPosition).toBe(2);
      expect((await findRegistration(event.id, w4.userId)).waitlistPosition).toBe(3);
    });

    it("leaves positions ahead of the cancelled user unchanged", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [, w1, , w3] = await registerUsersInOrder(event.id, 4);

      await cancel(event.id, w3.token);

      expect((await findRegistration(event.id, w1.userId)).waitlistPosition).toBe(1);
    });
  });

  describe("errors and edge cases", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const event = await createEvent();

      const response = await request(app).delete(`/api/events/${event.id}/register`);

      expect(response.status).toBe(401);
    });

    it("returns 404 REGISTRATION_NOT_FOUND when the user never registered", async () => {
      const event = await createEvent();
      const { token } = await createUser();

      const response = await cancel(event.id, token);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("REGISTRATION_NOT_FOUND");
    });

    it("returns 404 REGISTRATION_NOT_FOUND when cancelling twice", async () => {
      const event = await createEvent();
      const [user] = await registerUsersInOrder(event.id, 1);
      await cancel(event.id, user.token);

      const response = await cancel(event.id, user.token);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("REGISTRATION_NOT_FOUND");
    });

    it("returns 404 for an event that does not exist", async () => {
      const { token } = await createUser();

      const response = await cancel("00000000-0000-0000-0000-000000000000", token);

      expect(response.status).toBe(404);
    });

    it("only ever cancels the caller's own registration", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const [alice, bob] = await registerUsersInOrder(event.id, 2);

      await cancel(event.id, alice.token);

      expect((await findRegistration(event.id, bob.userId)).status).toBe("REGISTERED");
    });

    it("lets a user cancel on a CANCELLED event but promotes nobody (assumption: not in spec)", async () => {
      const event = await createEvent({ maxCapacity: 1 });
      const [seated, waitlist1] = await registerUsersInOrder(event.id, 2);
      await prisma.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });
      emailSpy.mockClear();

      const response = await cancel(event.id, seated.token);

      expect(response.status).toBe(200);
      expect((await findRegistration(event.id, waitlist1.userId)).status).toBe("WAITLISTED");
      expect(emailSpy).not.toHaveBeenCalled();
    });

    it("lets a cancelled user register again afterwards", async () => {
      const event = await createEvent({ maxCapacity: 10 });
      const [user] = await registerUsersInOrder(event.id, 1);
      await cancel(event.id, user.token);

      const response = await register(event.id, user.token);

      expect(response.status).toBe(201);
      expect(response.body.registration.status).toBe("REGISTERED");
    });
  });
});
