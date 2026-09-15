import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email("Must be a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
  name: z.string().min(1, "Name is required."),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email("Must be a valid email address."),
  password: z.string().min(1, "Password is required."),
});

export type LoginInput = z.infer<typeof loginSchema>;

// .strict() rejects any key besides `name` outright (400, with the
// offending field named in the error) rather than silently ignoring
// attempts to set e.g. `role` or `status` through this endpoint.
export const updateMeSchema = z
  .object({
    name: z.string().min(1, "Name is required.").optional(),
  })
  .strict();

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

// Shared shape for both /oauth/google and /oauth/github (spec §6): a
// single authorization code, nothing else.
export const oauthCodeSchema = z.object({
  code: z.string().min(1, "Authorization code is required."),
});

export type OAuthCodeInput = z.infer<typeof oauthCodeSchema>;
