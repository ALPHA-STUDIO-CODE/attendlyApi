import { prisma } from "../src/db/prisma";

// Fixed initial category list per spec §11 (admin-editable later, but this
// is the required starting set).
export const FIXED_CATEGORIES = [
  "Tech",
  "Music",
  "Business",
  "Sports",
  "Arts",
  "Food & Drink",
  "Health & Wellness",
  "Education",
  "Community",
  "Other",
] as const;

export async function seedCategories(): Promise<void> {
  await Promise.all(
    FIXED_CATEGORIES.map((name) =>
      prisma.category.upsert({
        where: { name },
        update: {},
        create: { name },
      }),
    ),
  );
}

async function main(): Promise<void> {
  await seedCategories();
}

// Only auto-run when executed directly (`prisma db seed` / `node seed.js`),
// not when imported by tests via `seedCategories`.
if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
