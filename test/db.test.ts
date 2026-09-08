import { prisma } from "../src/db/prisma";

describe("database connectivity", () => {
  it("connects via PrismaClient and runs a trivial query", async () => {
    const result = await prisma.$queryRaw<{ result: number }[]>`SELECT 1 as result`;

    expect(result).toEqual([{ result: 1 }]);
  });
});
