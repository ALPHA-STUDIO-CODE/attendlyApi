import { prisma } from "../src/db/prisma";

describe("Report model", () => {
  it("creates a report and traverses its event/reporter relations", async () => {
    const organizer = await prisma.user.create({
      data: {
        email: "b4-report-organizer@example.com",
        passwordHash: "hashed-password",
        name: "Report Organizer",
      },
    });
    const reporter = await prisma.user.create({
      data: {
        email: "b4-reporter@example.com",
        passwordHash: "hashed-password",
        name: "Reporter",
      },
    });
    const category = await prisma.category.findFirstOrThrow({ where: { name: "Community" } });

    const event = await prisma.event.create({
      data: {
        organizerId: organizer.id,
        title: "B4 Report Test Event",
        description: "Event used to exercise the Report model.",
        categoryId: category.id,
        venueName: "Test Hall",
        address: "123 Test St",
        city: "Testville",
        timezone: "America/New_York",
        date: new Date("2027-03-01T00:00:00.000Z"),
        startTime: new Date("2027-03-01T18:00:00.000Z"),
        endTime: new Date("2027-03-01T21:00:00.000Z"),
        maxCapacity: 20,
      },
    });

    const report = await prisma.report.create({
      data: {
        eventId: event.id,
        reporterId: reporter.id,
        reason: "Spam listing",
      },
    });

    expect(report.status).toBe("OPEN");

    const found = await prisma.report.findUniqueOrThrow({
      where: { id: report.id },
      include: { event: true, reporter: true },
    });

    expect(found.event.title).toBe("B4 Report Test Event");
    expect(found.reporter.email).toBe("b4-reporter@example.com");
  });
});
