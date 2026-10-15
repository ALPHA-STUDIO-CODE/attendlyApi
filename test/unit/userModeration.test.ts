import type { PrismaClient } from "@prisma/client";
import { reactivateUser, suspendUser } from "../../src/business/userModeration";
import { AppError } from "../../src/errors";

const tx = {
  user: { findUnique: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
  refreshToken: { deleteMany: jest.fn() },
};
const db = {
  ...tx,
  $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
} as unknown as PrismaClient;

const ADMIN_ID = "admin-1";
const VIEW = { id: "user-1", status: "SUSPENDED" };

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  tx.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER" });
  tx.user.updateMany.mockResolvedValue({ count: 1 });
  tx.user.findUniqueOrThrow.mockResolvedValue(VIEW);
  tx.refreshToken.deleteMany.mockResolvedValue({ count: 2 });
});

describe("suspendUser", () => {
  it("suspends an active user and deletes all of their refresh tokens", async () => {
    const result = await suspendUser(db, { actorId: ADMIN_ID, targetId: "user-1" });

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", status: "ACTIVE" },
      data: { status: "SUSPENDED" },
    });
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(result).toBe(VIEW);
  });

  it("does it all in one transaction", async () => {
    await suspendUser(db, { actorId: ADMIN_ID, targetId: "user-1" });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("is a 404 for a user that doesn't exist", async () => {
    tx.user.findUnique.mockResolvedValue(null);

    const error = await rejection(suspendUser(db, { actorId: ADMIN_ID, targetId: "nope" }));

    expect(error.statusCode).toBe(404);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to suspend yourself (409 CANNOT_SUSPEND_SELF)", async () => {
    tx.user.findUnique.mockResolvedValue({ id: ADMIN_ID, role: "ADMIN" });

    const error = await rejection(suspendUser(db, { actorId: ADMIN_ID, targetId: ADMIN_ID }));

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CANNOT_SUSPEND_SELF");
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to suspend another admin (409 CANNOT_SUSPEND_ADMIN)", async () => {
    tx.user.findUnique.mockResolvedValue({ id: "admin-2", role: "ADMIN" });

    const error = await rejection(suspendUser(db, { actorId: ADMIN_ID, targetId: "admin-2" }));

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CANNOT_SUSPEND_ADMIN");
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("still clears leftover tokens when the user was already suspended", async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });

    await suspendUser(db, { actorId: ADMIN_ID, targetId: "user-1" });

    expect(tx.refreshToken.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("reactivateUser", () => {
  it("sets a suspended user back to ACTIVE", async () => {
    tx.user.findUnique.mockResolvedValue({ id: "user-1" });

    await reactivateUser(db, "user-1");

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", status: "SUSPENDED" },
      data: { status: "ACTIVE" },
    });
  });

  it("does not touch refresh tokens", async () => {
    tx.user.findUnique.mockResolvedValue({ id: "user-1" });

    await reactivateUser(db, "user-1");

    expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("is a 404 for a user that doesn't exist", async () => {
    tx.user.findUnique.mockResolvedValue(null);

    const error = await rejection(reactivateUser(db, "nope"));

    expect(error.statusCode).toBe(404);
  });
});
