import { z } from "zod";

export const checkInSchema = z.object({
  ticketToken: z.string(),
});
