import type { AccessTokenPayload } from "../auth/jwt";

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

// Required for TypeScript to treat this file as a module (needed for
// `declare global` to work) rather than a script.
export {};
