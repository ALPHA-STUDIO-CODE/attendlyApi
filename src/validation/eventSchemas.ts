import { z } from "zod";

export const createEventSchema = z.object({
  title: z.string().min(1, "Title is required.").max(200),
  description: z.string().min(1, "Description is required."),
  categoryId: z.string().min(1, "categoryId is required."),
  customTags: z.array(z.string()).max(20).default([]),
  venueName: z.string().min(1, "Venue name is required."),
  address: z.string().min(1, "Address is required."),
  city: z.string().min(1, "City is required."),
  timezone: z.string().min(1, "Timezone is required."),
  date: z.string().datetime({ message: "date must be an ISO 8601 datetime string." }),
  startTime: z.string().datetime({ message: "startTime must be an ISO 8601 datetime string." }),
  endTime: z.string().datetime({ message: "endTime must be an ISO 8601 datetime string." }),
  maxCapacity: z.number().int("maxCapacity must be an integer."),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = createEventSchema
  .omit({ customTags: true })
  .partial()
  .extend({
    customTags: z.array(z.string()).max(20).optional(),
  });

export type UpdateEventInput = z.infer<typeof updateEventSchema>;
