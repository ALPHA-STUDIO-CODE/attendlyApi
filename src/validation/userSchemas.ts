import { z } from "zod";

export const userStatusFilterSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.enum(["ACTIVE", "SUSPENDED"]));

export const USER_SEARCH_MAX_LENGTH = 100;
