import { prisma } from "../src/db/prisma";

export default async function globalTeardown(): Promise<void> {
  await prisma.$disconnect();
}
