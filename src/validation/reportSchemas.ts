import { z } from "zod";

export const REPORT_REASON_MAX_LENGTH = 1000;

export const createReportSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required.")
    .max(
      REPORT_REASON_MAX_LENGTH,
      `Reason must be at most ${REPORT_REASON_MAX_LENGTH} characters.`,
    ),
});

export type CreateReportInput = z.infer<typeof createReportSchema>;

export const updateReportSchema = z.object({
  status: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(
      z.enum(["OPEN", "REVIEWED", "DISMISSED"], {
        message: "Status must be one of: open, reviewed, dismissed.",
      }),
    ),
});

export type UpdateReportInput = z.infer<typeof updateReportSchema>;

export const reportStatusFilterSchema = updateReportSchema.shape.status;
