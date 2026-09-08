import { PrismaClient } from "@prisma/client";

// A single shared PrismaClient instance for the whole process. Prisma
// manages its own internal connection pool, so this should be reused
// rather than instantiated per-request.
export const prisma = new PrismaClient();
