import { RequestHandler } from "express";
import { verifyAccessToken } from "../auth/jwt";
import { AuthError } from "../errors";

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!token) {
    throw new AuthError("Authentication required.", undefined, "UNAUTHENTICATED");
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    // Per spec §9: expired AND invalid/tampered tokens deliberately share
    // one code, so the frontend's silent-refresh-then-retry interceptor
    // has a single trigger condition rather than needing to branch on
    // *why* the token was rejected.
    throw new AuthError("Access token is invalid or expired.", undefined, "TOKEN_EXPIRED");
  }
};
