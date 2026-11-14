import { z } from "zod";
import { AppError } from "./errors.ts";

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "1234567890", "12345678910", "qwertyuiop",
  "minecraft", "minecraft1", "minecraft123", "iloveminecraft", "letmein123", "welcome123",
]);

const noControlChars = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

export const minecraftUsername = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,16}$/, "Minecraft usernames are 3-16 characters: letters, numbers and underscores");

export const displayName = z
  .string()
  .trim()
  .min(2, "Display name must be at least 2 characters")
  .max(32, "Display name must be at most 32 characters")
  .refine(noControlChars, "Display name contains invalid characters");

export const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), "That password is too common");

export const registerSchema = z
  .object({
    displayName,
    minecraftUsername,
    accountType: z.enum(["PREMIUM", "OFFLINE"], { message: "Choose Premium or Offline" }),
    password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" })
  .refine((v) => v.password.toLowerCase() !== v.minecraftUsername.toLowerCase(), {
    path: ["password"],
    message: "Password must not be your username",
  });

export const newPasswordSchema = z
  .object({ password, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" });

/** Parses input or throws a VALIDATION AppError carrying per-field messages. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const k = issue.path.join(".") || "_";
    fields[k] ??= issue.message;
  }
  const first = Object.values(fields)[0] ?? "Invalid input";
  throw new AppError("VALIDATION", first, { fields });
}
