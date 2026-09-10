import { prisma } from "../src/db/prisma";

describe("ReminderConfig model", () => {
  it("creates a reminder config and traverses its event relation", async () => {
    const organizer = await prisma.user.create({
      data: {
        email: "b4-reminder-organizer@example.com",
        passwordHash: "hashed-password",
        name: "Reminder Organizer",
      },
    });
    const category = await prisma.category.findFirstOrThrow({ where: { name: "Education" } });

    const event = await prisma.event.create({
      data: {
        organizerId: organizer.id,
        title: "B4 Reminder Test Event",
        description: "Event used to exercise the ReminderConfig model.",
        categoryId: category.id,
        venueName: "Test Hall",
        address: "123 Test St",
        city: "Testville",
        timezone: "America/New_York",
        date: new Date("2027-04-01T00:00:00.000Z"),
        startTime: new Date("2027-04-01T18:00:00.000Z"),
        endTime: new Date("2027-04-01T21:00:00.000Z"),
        maxCapacity: 30,
      },
    });

    const reminderConfig = await prisma.reminderConfig.create({
      data: {
        eventId: event.id,
        hoursBefore: 24,
      },
    });

    expect(reminderConfig.sent).toBe(false);

    const found = await prisma.reminderConfig.findUniqueOrThrow({
      where: { id: reminderConfig.id },
      include: { event: true },
    });

    expect(found.event.title).toBe("B4 Reminder Test Event");
  });
});
