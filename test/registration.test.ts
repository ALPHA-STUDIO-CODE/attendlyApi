import { prisma } from "../src/db/prisma";

async function createOrganizerAndEvent() {
  const organizer = await prisma.user.create({
    data: {
      email: `b4-organizer-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hashed-password",
      name: "Event Organizer",
    },
  });

  const category = await prisma.category.findFirstOrThrow({ where: { name: "Tech" } });

  const event = await prisma.event.create({
    data: {
      organizerId: organizer.id,
      title: "B4 Registration Test Event",
      description: "Event used to exercise Registration constraints.",
      categoryId: category.id,
      venueName: "Test Hall",
      address: "123 Test St",
      city: "Testville",
      timezone: "America/New_York",
      date: new Date("2027-02-01T00:00:00.000Z"),
      startTime: new Date("2027-02-01T18:00:00.000Z"),
      endTime: new Date("2027-02-01T21:00:00.000Z"),
      maxCapacity: 50,
    },
  });

  return { organizer, event };
}

describe("Registration model", () => {
  it("rejects a duplicate (eventId, userId) registration with a unique-constraint error", async () => {
    const { event } = await createOrganizerAndEvent();

    const attendee = await prisma.user.create({
      data: {
        email: "b4-attendee@example.com",
        passwordHash: "hashed-password",
        name: "Attendee",
      },
    });

    await prisma.registration.create({
      data: {
        eventId: event.id,
        userId: attendee.id,
        ticketToken: "ticket-token-1",
      },
    });

    await expect(
      prisma.registration.create({
        data: {
          eventId: event.id,
          userId: attendee.id,
          ticketToken: "ticket-token-2",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows the same user to register for two different events", async () => {
    const { event: eventA } = await createOrganizerAndEvent();
    const { event: eventB } = await createOrganizerAndEvent();

    const attendee = await prisma.user.create({
      data: {
        email: "b4-multi-event-attendee@example.com",
        passwordHash: "hashed-password",
        name: "Multi-Event Attendee",
      },
    });

    await prisma.registration.create({
      data: { eventId: eventA.id, userId: attendee.id, ticketToken: "ticket-token-a" },
    });
    await prisma.registration.create({
      data: { eventId: eventB.id, userId: attendee.id, ticketToken: "ticket-token-b" },
    });

    const registrations = await prisma.registration.findMany({
      where: { userId: attendee.id },
    });
    expect(registrations).toHaveLength(2);
  });
});
