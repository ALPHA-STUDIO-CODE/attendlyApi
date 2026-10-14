import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { requireStringParam, firstQueryValue } from "../http/params";
import { parsePagination } from "../business/pagination";
import { reportStatusFilterSchema, updateReportSchema } from "../validation/reportSchemas";
import { zodIssuesToFields } from "../validation/zodHelpers";
import { logger } from "../logger";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("ADMIN"));

const reportSelect = {
  id: true,
  reason: true,
  status: true,
  createdAt: true,
  reporter: { select: { id: true, name: true, email: true } },
  event: {
    select: { id: true, title: true, status: true, deletedAt: true, organizerId: true },
  },
} as const;

adminRouter.get("/reports", async (req, res) => {
  const { page, limit } = parsePagination(req.query.page, req.query.limit);

  const where: Prisma.ReportWhereInput = {};
  const rawStatus = firstQueryValue(req.query.status);
  if (rawStatus !== undefined && rawStatus !== "") {
    const parsed = reportStatusFilterSchema.safeParse(rawStatus);
    if (!parsed.success) {
      throw new ValidationError("Invalid report filter.", {
        fields: { status: "Status must be one of: open, reviewed, dismissed." },
      });
    }
    where.status = parsed.data;
  }

  const [reports, total] = await Promise.all([
    prisma.report.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: reportSelect,
    }),
    prisma.report.count({ where }),
  ]);

  res.status(200).json({
    reports,
    pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
  });
});

adminRouter.patch("/reports/:id", async (req, res) => {
  const id = requireStringParam(req, "id");

  const parsed = updateReportSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid report update.", {
      fields: zodIssuesToFields(parsed.error.issues),
    });
  }

  const existing = await prisma.report.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw new NotFoundError("Report not found.");
  }

  const report = await prisma.report.update({
    where: { id },
    data: { status: parsed.data.status },
    select: reportSelect,
  });

  logger.info(
    { reportId: id, status: parsed.data.status, adminId: req.user!.sub },
    "Report status changed",
  );

  res.status(200).json({ report });
});

adminRouter.get("/events/:id", async (req, res) => {
  const id = requireStringParam(req, "id");

  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      category: true,
      organizer: { select: { id: true, name: true, email: true } },
      _count: { select: { reports: true } },
    },
  });
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  res.status(200).json({ event });
});

adminRouter.delete("/events/:id", async (req, res) => {
  const id = requireStringParam(req, "id");

  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("Event not found.");
  }
  if (existing.deletedAt) {
    res.status(200).json({ event: existing });
    return;
  }

  await prisma.event.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const event = await prisma.event.findUniqueOrThrow({ where: { id } });

  logger.info({ eventId: id, adminId: req.user!.sub }, "Event removed by admin");

  res.status(200).json({ event });
});

adminRouter.patch("/events/:id/flag", async (req, res) => {
  const id = requireStringParam(req, "id");

  const existing = await prisma.event.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new NotFoundError("Event not found.");
  }
  if (existing.status === "FLAGGED") {
    res.status(200).json({ event: existing });
    return;
  }
  if (existing.status === "CANCELLED") {
    throw new ConflictError(
      "A cancelled event cannot be flagged.",
      undefined,
      "EVENT_NOT_FLAGGABLE",
    );
  }

  const { count } = await prisma.event.updateMany({
    where: { id, deletedAt: null, status: "PUBLISHED" },
    data: { status: "FLAGGED" },
  });
  if (count === 0) {
    throw new ConflictError("The event changed; please try again.", undefined, "EVENT_CHANGED");
  }
  const event = await prisma.event.findUniqueOrThrow({ where: { id } });

  logger.info({ eventId: id, adminId: req.user!.sub }, "Event flagged by admin");

  res.status(200).json({ event });
});
