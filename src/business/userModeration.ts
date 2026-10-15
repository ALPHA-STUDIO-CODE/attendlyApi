import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../errors";

export const ADMIN_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  authProvider: true,
  status: true,
  createdAt: true,
} as const;

export interface SuspendUserParams {
  actorId: string;
  targetId: string;
}

export async function suspendUser(db: PrismaClient, { actorId, targetId }: SuspendUserParams) {
  return db.$transaction(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true },
    });
    if (!target) {
      throw new NotFoundError("User not found.");
    }
    if (target.id === actorId) {
      throw new ConflictError(
        "You cannot suspend your own account.",
        undefined,
        "CANNOT_SUSPEND_SELF",
      );
    }
    if (target.role === "ADMIN") {
      throw new ConflictError(
        "Admin accounts cannot be suspended.",
        undefined,
        "CANNOT_SUSPEND_ADMIN",
      );
    }

    await tx.user.updateMany({
      where: { id: targetId, status: "ACTIVE" },
      data: { status: "SUSPENDED" },
    });
    await tx.refreshToken.deleteMany({ where: { userId: targetId } });

    return tx.user.findUniqueOrThrow({ where: { id: targetId }, select: ADMIN_USER_SELECT });
  });
}

export async function reactivateUser(db: PrismaClient, targetId: string) {
  const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!target) {
    throw new NotFoundError("User not found.");
  }

  await db.user.updateMany({
    where: { id: targetId, status: "SUSPENDED" },
    data: { status: "ACTIVE" },
  });
  return db.user.findUniqueOrThrow({ where: { id: targetId }, select: ADMIN_USER_SELECT });
}
