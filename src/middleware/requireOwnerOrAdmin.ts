import { RequestHandler } from "express";
import { prisma } from "../db/prisma";
import { requireStringParam } from "../http/params";
import { NotFoundError, ForbiddenError } from "../errors";

interface RequireOwnerOrAdminOptions {
  allowAdmin?: boolean;
}

export function requireOwnerOrAdmin(options: RequireOwnerOrAdminOptions = {}): RequestHandler {
  const { allowAdmin = true } = options;

  return async (req, _res, next) => {
    const eventId = requireStringParam(req, "id");

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      throw new NotFoundError("Event not found.");
    }

    const isOwner = event.organizerId === req.user?.sub;
    const isAdmin = allowAdmin && req.user?.role === "ADMIN";

    if (!isOwner && !isAdmin) {
      throw new ForbiddenError("You do not have permission to perform this action.");
    }

    req.event = event;
    next();
  };
}
