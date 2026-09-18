import type { AccessTokenPayload } from "../auth/jwt";
import type { Event } from "@prisma/client";

// `declare global { namespace Express { ... } }` is Express's own
// documented pattern for augmenting its Request type — there's no
// ES2015-module equivalent for extending a third-party namespace.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
      // Set by requireOwnerOrAdmin (Phase E) after loading the event named
      // by req.params.id — downstream handlers reuse it rather than
      // re-querying.
      event?: Event;
    }
  }
}

// Required for TypeScript to treat this file as a module (needed for
// `declare global` to work) rather than a script.
export {};
