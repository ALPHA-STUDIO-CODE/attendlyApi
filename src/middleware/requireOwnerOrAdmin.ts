import { RequestHandler } from "express";
import { prisma } from "../db/prisma";
import { NotFoundError, ForbiddenError } from "../errors";

interface RequireOwnerOrAdminOptions {
  /**
   * Default true (admin included alongside the owner) — correct for most
   * uses per spec §3's table: viewing attendees/check-in, exporting the
   * attendee CSV. Set to false for the two actions spec explicitly
   * excludes admin from: editing event content and cancelling an event
   * ("Edit own event" / "Cancel own event" both show admin as "—" in the
   * table, and "Edit another user's event content" is explicitly "never").
   */
  allowAdmin?: boolean;
}

/**
 * Must run after requireAuth. Loads the event named by req.params.id,
 * 404s if it doesn't exist, then requires the caller to be either the
 * event's organizer or (unless allowAdmin is false) an admin. Attaches
 * the loaded event to req.event so downstream handlers don't need a
 * second query for it.
 */
export function requireOwnerOrAdmin(options: RequireOwnerOrAdminOptions = {}): RequestHandler {
  const { allowAdmin = true } = options;

  return async (req, _res, next) => {
    const eventId = req.params.id;
    if (typeof eventId !== "string") {
      // Can't actually happen for our /:id route pattern at runtime —
      // Express 5's ParamsDictionary type is string | string[] to also
      // cover repeated-param routes like /:id+, which this route isn't.
      throw new NotFoundError("Event not found.");
    }

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
