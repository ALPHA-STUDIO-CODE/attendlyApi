import type { Prisma } from "@prisma/client";
import { diffReminderConfigs, replaceReminderConfigs } from "../../src/business/reminderConfigs";

describe("diffReminderConfigs", () => {
  const existing = [
    { id: "r24", hoursBefore: 24 },
    { id: "r1", hoursBefore: 1 },
  ];

  it("changes nothing when the desired set equals the existing one", () => {
    expect(diffReminderConfigs(existing, [24, 1])).toEqual({ deleteIds: [], createHours: [] });
  });

  it("ignores the order of the desired offsets", () => {
    expect(diffReminderConfigs(existing, [1, 24])).toEqual({ deleteIds: [], createHours: [] });
  });

  it("adds new offsets and keeps the rest", () => {
    expect(diffReminderConfigs(existing, [24, 1, 6])).toEqual({ deleteIds: [], createHours: [6] });
  });

  it("removes offsets that are no longer wanted", () => {
    expect(diffReminderConfigs(existing, [24])).toEqual({ deleteIds: ["r1"], createHours: [] });
  });

  it("replaces one offset with another, keeping the one in common", () => {
    expect(diffReminderConfigs(existing, [24, 12])).toEqual({
      deleteIds: ["r1"],
      createHours: [12],
    });
  });

  it("replaces everything when nothing overlaps", () => {
    expect(diffReminderConfigs(existing, [12])).toEqual({
      deleteIds: ["r24", "r1"],
      createHours: [12],
    });
  });

  it("clears everything for an empty desired set", () => {
    expect(diffReminderConfigs(existing, [])).toEqual({
      deleteIds: ["r24", "r1"],
      createHours: [],
    });
  });

  it("creates everything when there is nothing yet", () => {
    expect(diffReminderConfigs([], [24, 1])).toEqual({ deleteIds: [], createHours: [24, 1] });
  });
});

describe("replaceReminderConfigs", () => {
  const tx = {
    reminderConfig: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const asTx = tx as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    tx.reminderConfig.findMany.mockResolvedValue([
      { id: "r24", hoursBefore: 24 },
      { id: "r1", hoursBefore: 1 },
    ]);
    tx.reminderConfig.deleteMany.mockResolvedValue({ count: 1 });
    tx.reminderConfig.createMany.mockResolvedValue({ count: 1 });
  });

  it("deletes only the removed rows and creates only the new ones", async () => {
    await replaceReminderConfigs(asTx, "evt-1", [24, 6]);

    expect(tx.reminderConfig.findMany).toHaveBeenCalledWith({
      where: { eventId: "evt-1" },
      select: { id: true, hoursBefore: true },
    });
    expect(tx.reminderConfig.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r1"] } } });
    expect(tx.reminderConfig.createMany).toHaveBeenCalledWith({
      data: [{ eventId: "evt-1", hoursBefore: 6 }],
    });
  });

  it("touches nothing when the set is unchanged — so a sent flag can't be reset", async () => {
    await replaceReminderConfigs(asTx, "evt-1", [1, 24]);

    expect(tx.reminderConfig.deleteMany).not.toHaveBeenCalled();
    expect(tx.reminderConfig.createMany).not.toHaveBeenCalled();
  });

  it("skips the delete when there is nothing to remove, and the insert when nothing is new", async () => {
    await replaceReminderConfigs(asTx, "evt-1", [24, 1, 12]);
    expect(tx.reminderConfig.deleteMany).not.toHaveBeenCalled();
    expect(tx.reminderConfig.createMany).toHaveBeenCalledTimes(1);

    tx.reminderConfig.createMany.mockClear();
    await replaceReminderConfigs(asTx, "evt-1", [24]);
    expect(tx.reminderConfig.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.reminderConfig.createMany).not.toHaveBeenCalled();
  });
});
