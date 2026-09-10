import { prisma } from "../src/db/prisma";
import { seedCategories, FIXED_CATEGORIES } from "../prisma/seed";

describe("Category seed", () => {
  it("seeds exactly the 10 fixed categories with unique names", async () => {
    // globalSetup already seeded once; re-run here to also exercise
    // idempotency within this test's own assertions.
    await seedCategories();

    const categories = await prisma.category.findMany();

    expect(categories).toHaveLength(FIXED_CATEGORIES.length);
    const names = categories.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual([...FIXED_CATEGORIES].sort());
  });

  it("re-running the seed does not create duplicates", async () => {
    await seedCategories();
    await seedCategories();

    const categories = await prisma.category.findMany();
    expect(categories).toHaveLength(FIXED_CATEGORIES.length);
  });
});
