import { prisma } from "../src/db/prisma";

describe("Event model", () => {
  it("creates an event referencing a seeded category and organizer, with relations traversable", async () => {
    const organizer = await prisma.user.create({
      data: {
        email: "b3-organizer@example.com",
        passwordHash: "hashed-password",
        name: "Event Organizer",
      },
    });

    const category = await prisma.category.findFirstOrThrow({
      where: { name: "Tech" },
    });

    const event = await prisma.event.create({
      data: {
        organizerId: organizer.id,
        title: "Test Conference",
        description: "A test event created for B3 verification.",
        categoryId: category.id,
        customTags: ["testing", "prisma"],
        venueName: "Test Hall",
        address: "123 Test St",
        city: "Testville",
        timezone: "America/New_York",
        date: new Date("2027-01-15T00:00:00.000Z"),
        startTime: new Date("2027-01-15T18:00:00.000Z"),
        endTime: new Date("2027-01-15T21:00:00.000Z"),
        maxCapacity: 100,
      },
    });

    expect(event.status).toBe("PUBLISHED");
    expect(event.isLocked).toBe(false);

    const found = await prisma.event.findUniqueOrThrow({
      where: { id: event.id },
      include: { organizer: true, category: true },
    });

    expect(found.organizer.email).toBe("b3-organizer@example.com");
    expect(found.category.name).toBe("Tech");
  });
});
