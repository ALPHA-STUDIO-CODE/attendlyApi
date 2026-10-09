import { Router } from "express";
import { prisma } from "../db/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { ACTIVE_REGISTRATION_STATUSES } from "../business/registrationListing";

export const meRouter = Router();

// The caller's own registrations. `ticketToken` is included on purpose: it is
// the caller's own QR payload (spec §7.4) and the client needs it to render
// the ticket. Organizer-facing listings never expose it.
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
  // One clock reading for both queries, so a row can't land in both lists
  // (or neither) if an event ends between them.
  const now = new Date();
  const base = { userId, status: { in: ACTIVE_REGISTRATION_STATUSES } };

  const [upcoming, past] = await Promise.all([
    prisma.registration.findMany({
      where: { ...base, event: { endTime: { gte: now } } },
      orderBy: [{ event: { startTime: "asc" } }, { createdAt: "asc" }],
      select: ownRegistrationSelect,
    }),
    prisma.registration.findMany({
      where: { ...base, event: { endTime: { lt: now } } },
      orderBy: [{ event: { startTime: "desc" } }, { createdAt: "asc" }],
      select: ownRegistrationSelect,
    }),
  ]);

  res.status(200).json({ upcoming, past });
});
