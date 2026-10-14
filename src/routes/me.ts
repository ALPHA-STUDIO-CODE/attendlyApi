import { Router } from "express";
import { prisma } from "../db/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { ACTIVE_REGISTRATION_STATUSES } from "../business/registrationListing";

export const meRouter = Router();

const ownRegistrationSelect = {
  id: true,
  eventId: true,
  status: true,
  waitlistPosition: true,
  checkedInAt: true,
  ticketToken: true,
  createdAt: true,
  event: {
    select: {
      id: true,
      title: true,
      date: true,
      startTime: true,
      endTime: true,
      venueName: true,
      city: true,
      timezone: true,
      status: true,
      bannerImageUrl: true,
    },
  },
} as const;

meRouter.get("/registrations", requireAuth, async (req, res) => {
  const userId = req.user!.sub;
  const now = new Date();
  const base = {
    userId,
    status: { in: ACTIVE_REGISTRATION_STATUSES },
    event: { deletedAt: null },
  };

  const [upcoming, past] = await Promise.all([
    prisma.registration.findMany({
      where: { ...base, event: { ...base.event, endTime: { gte: now } } },
      orderBy: [{ event: { startTime: "asc" } }, { createdAt: "asc" }],
      select: ownRegistrationSelect,
    }),
    prisma.registration.findMany({
      where: { ...base, event: { ...base.event, endTime: { lt: now } } },
      orderBy: [{ event: { startTime: "desc" } }, { createdAt: "asc" }],
      select: ownRegistrationSelect,
    }),
  ]);

  res.status(200).json({ upcoming, past });
});
