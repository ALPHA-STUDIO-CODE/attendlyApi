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

export const updateMeSchema = z
  .object({
    name: z.string().min(1, "Name is required.").optional(),
  })
  .strict();

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const oauthCodeSchema = z.object({
  code: z.string().min(1, "Authorization code is required."),
});

export type OAuthCodeInput = z.infer<typeof oauthCodeSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email("Must be a valid email address."),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Reset token is required."),
  newPassword: z.string().min(8, "Password must be at least 8 characters."),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
