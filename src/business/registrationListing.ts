import type { Prisma, RegistrationStatus } from "@prisma/client";

/**
 * Registration rows that still represent a person attending (or waiting to
 * attend). CANCELLED rows are history, not attendees, so the listing
 * endpoints leave them out.
 */
export const ACTIVE_REGISTRATION_STATUSES: RegistrationStatus[] = ["REGISTERED", "WAITLISTED"];

/**
 * Order for organizer-facing attendee lists (the H4 list and the H5 CSV
 * export): seated attendees first, then the waitlist in queue order.
 * Postgres sorts enums by declaration order (REGISTERED, WAITLISTED, ...),
 * and `id` is the final tiebreaker so pagination stays stable when
 * everything else ties.
 */
export const ATTENDEE_LIST_ORDER_BY: Prisma.RegistrationOrderByWithRelationInput[] = [
  { status: "asc" },
  { waitlistPosition: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];
