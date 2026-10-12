import { z } from "zod";
import { MAX_REMINDER_CONFIGS_PER_EVENT, MAX_REMINDER_HOURS_BEFORE } from "../business/reminders";

// Spec §7.5: reminders are configured as part of the event payload. Offsets
// are whole hours from 1 to MAX_REMINDER_HOURS_BEFORE, a handful per event,
// and duplicates are rejected (they would just send the same reminder twice).
const reminderConfigSchema = z.object({
  hoursBefore: z
    .number()
    .int("hoursBefore must be a whole number.")
    .min(1, "hoursBefore must be at least 1.")
    .max(MAX_REMINDER_HOURS_BEFORE, `hoursBefore must be at most ${MAX_REMINDER_HOURS_BEFORE}.`),
});

export const reminderConfigsSchema = z
  .array(reminderConfigSchema)
  .max(
    MAX_REMINDER_CONFIGS_PER_EVENT,
    `An event can have at most ${MAX_REMINDER_CONFIGS_PER_EVENT} reminders.`,
  )
  .superRefine((configs, ctx) => {
    const seen = new Set<number>();
    configs.forEach((config, index) => {
      if (seen.has(config.hoursBefore)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "hoursBefore"],
          message: "Duplicate reminder.",
        });
      }
      seen.add(config.hoursBefore);
    });
  });

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
  reminderConfigs: reminderConfigsSchema.default([]),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;

// `customTags` and `reminderConfigs` are re-declared as plain optionals: in
// an edit, "not sent" must mean "leave untouched", not "apply the default".
export const updateEventSchema = createEventSchema
  .omit({ customTags: true, reminderConfigs: true })
  .partial()
  .extend({
    customTags: z.array(z.string()).max(20).optional(),
    reminderConfigs: reminderConfigsSchema.optional(),
  });

export type UpdateEventInput = z.infer<typeof updateEventSchema>;
