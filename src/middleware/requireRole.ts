import { RequestHandler } from "express";
import { ForbiddenError } from "../errors";
import type { Role } from "@prisma/client";

/**
 * Must run after requireAuth (needs req.user set). Throws 403 if the
 * authenticated user's role isn't in the allowed list.
 */
export function requireRole(...allowedRoles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role as Role)) {
      throw new ForbiddenError("You do not have permission to perform this action.");
    }
    next();
  };
}
