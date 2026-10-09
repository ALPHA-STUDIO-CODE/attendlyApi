import type { RegistrationStatus } from "@prisma/client";

/**
 * Registration rows that still represent a person attending (or waiting to
 * attend). CANCELLED rows are history, not attendees, so the listing
 * endpoints leave them out.
 */
export const ACTIVE_REGISTRATION_STATUSES: RegistrationStatus[] = ["REGISTERED", "WAITLISTED"];
