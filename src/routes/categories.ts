import { Router } from "express";
import { prisma } from "../db/prisma";
import { isUniqueConstraintError } from "../db/prismaErrors";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { createCategorySchema } from "../validation/categorySchemas";
import { zodIssuesToFields } from "../validation/zodHelpers";
import { ValidationError, ConflictError } from "../errors";

export const categoryRouter = Router();

categoryRouter.get("/", async (_req, res) => {
  const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
  res.status(200).json({ categories });
});

categoryRouter.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid category.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }

  try {
    const category = await prisma.category.create({ data: parsed.data });
    res.status(201).json({ category });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(
        "A category with this name already exists.",
        undefined,
        "CATEGORY_EXISTS",
      );
    }
    throw err;
  }
});
