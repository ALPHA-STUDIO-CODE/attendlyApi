import { Router } from "express";
import { prisma } from "../db/prisma";
import { isForeignKeyConstraintError } from "../db/prismaErrors";
import { requireAuth } from "../middleware/requireAuth";
import { requireOwnerOrAdmin } from "../middleware/requireOwnerOrAdmin";
import { requireStringParam, firstQueryValue } from "../http/params";
import { createEventSchema, updateEventSchema } from "../validation/eventSchemas";
import { zodIssuesToFields } from "../validation/zodHelpers";
import { getEventSemanticErrors } from "../business/eventSemantics";
import { getRejectedLockedFields } from "../business/fieldLock";
import { parsePagination } from "../business/pagination";
import { buildEventWhereClause } from "../business/eventFilters";
import { detectImageType } from "../business/imageType";
import { queueCancellationEmails } from "../email/queueCancellationEmails";
import { uploadBannerImage } from "../integrations/cloudinary";
import { parseBannerUpload, BANNER_FIELD_NAME } from "../middleware/uploadBanner";
import { logger } from "../logger";
import {
  ValidationError,
  UnprocessableEntityError,
  ConflictError,
  NotFoundError,
  BadGatewayError,
} from "../errors";

export const eventRouter = Router();

eventRouter.post("/", requireAuth, async (req, res) => {
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid event.", { fields: zodIssuesToFields(parsed.error.issues) });
  }

  const semanticErrors = getEventSemanticErrors(parsed.data);
  if (Object.keys(semanticErrors).length > 0) {
    throw new UnprocessableEntityError("Invalid event.", { fields: semanticErrors });
  }

  try {
    const event = await prisma.event.create({
      data: {
        organizerId: req.user!.sub,
        title: parsed.data.title,
        description: parsed.data.description,
        categoryId: parsed.data.categoryId,
        customTags: parsed.data.customTags,
        venueName: parsed.data.venueName,
        address: parsed.data.address,
        city: parsed.data.city,
        timezone: parsed.data.timezone,
        date: new Date(parsed.data.date),
        startTime: new Date(parsed.data.startTime),
        endTime: new Date(parsed.data.endTime),
        maxCapacity: parsed.data.maxCapacity,
      },
    });
    res.status(201).json({ event });
  } catch (err) {
    if (isForeignKeyConstraintError(err)) {
      throw new ValidationError("Invalid event.", {
        fields: { categoryId: "Category not found." },
      });
    }
    throw err;
  }
});

eventRouter.get("/", async (req, res) => {
  const { page, limit } = parsePagination(req.query.page, req.query.limit);
  const where = buildEventWhereClause({
    category: firstQueryValue(req.query.category),
    city: firstQueryValue(req.query.city),
    from: firstQueryValue(req.query.from),
    to: firstQueryValue(req.query.to),
    upcoming: firstQueryValue(req.query.upcoming),
    search: firstQueryValue(req.query.search),
  });

  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { date: "asc" },
      include: { category: true },
    }),
    prisma.event.count({ where }),
  ]);

  res.status(200).json({
    events,
    pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
  });
});

eventRouter.get("/:id", async (req, res) => {
  const id = requireStringParam(req, "id");

  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      category: true,
      organizer: { select: { id: true, name: true } },
    },
  });
  if (!event) {
    throw new NotFoundError("Event not found.");
  }

  res.status(200).json({ event });
});

eventRouter.patch(
  "/:id",
  requireAuth,
  requireOwnerOrAdmin({ allowAdmin: false }),
  async (req, res) => {
    const event = req.event!;

    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid event update.", {
        fields: zodIssuesToFields(parsed.error.issues),
      });
    }

    const changedFields = Object.keys(parsed.data);
    const rejectedFields = getRejectedLockedFields(changedFields, event.isLocked);
    if (rejectedFields.length > 0) {
      throw new ConflictError(
        "Cannot edit locked fields on an event that already has registrations.",
        { lockedFields: rejectedFields },
        "EVENT_LOCKED",
      );
    }

    const merged = {
      date: parsed.data.date,
      startTime: parsed.data.startTime ?? event.startTime.toISOString(),
      endTime: parsed.data.endTime ?? event.endTime.toISOString(),
      maxCapacity: parsed.data.maxCapacity ?? event.maxCapacity,
      timezone: parsed.data.timezone ?? event.timezone,
    };
    const semanticErrors = getEventSemanticErrors(merged);
    if (Object.keys(semanticErrors).length > 0) {
      throw new UnprocessableEntityError("Invalid event update.", { fields: semanticErrors });
    }

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: {
        ...parsed.data,
        date: parsed.data.date ? new Date(parsed.data.date) : undefined,
        startTime: parsed.data.startTime ? new Date(parsed.data.startTime) : undefined,
        endTime: parsed.data.endTime ? new Date(parsed.data.endTime) : undefined,
      },
    });

    res.status(200).json({ event: updated });
  },
);

eventRouter.delete(
  "/:id",
  requireAuth,
  requireOwnerOrAdmin({ allowAdmin: false }),
  async (req, res) => {
    const event = req.event!;

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { status: "CANCELLED" },
    });

    await queueCancellationEmails(updated.id);

    res.status(200).json({ event: updated });
  },
);

eventRouter.post(
  "/:id/banner",
  requireAuth,
  requireOwnerOrAdmin({ allowAdmin: false }),
  parseBannerUpload,
  async (req, res) => {
    const event = req.event!;

    const file = req.file;
    if (!file) {
      throw new ValidationError("Invalid banner upload.", {
        fields: { [BANNER_FIELD_NAME]: "A banner image file is required." },
      });
    }

    if (!detectImageType(file.buffer)) {
      throw new ValidationError("Invalid banner upload.", {
        fields: { [BANNER_FIELD_NAME]: "Banner must be a JPEG, PNG, or WebP image." },
      });
    }

    let bannerImageUrl: string;
    try {
      bannerImageUrl = await uploadBannerImage({ buffer: file.buffer, eventId: event.id });
    } catch (err) {
      logger.error(
        { requestId: req.id, eventId: event.id, err },
        "Banner upload to Cloudinary failed",
      );
      throw new BadGatewayError(
        "Banner upload failed. Please try again.",
        undefined,
        "UPLOAD_FAILED",
      );
    }

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { bannerImageUrl },
    });

    res.status(200).json({ event: updated });
  },
);
