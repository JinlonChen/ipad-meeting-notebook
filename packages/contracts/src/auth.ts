import { z } from "zod";

export const LoginInputSchema = z.object({
  password: z.string().min(12).max(256),
});

export const SessionUserSchema = z.object({
  id: z.literal("owner"),
  sessionExpiresAt: z.iso.datetime(),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;
export type SessionUser = z.infer<typeof SessionUserSchema>;
