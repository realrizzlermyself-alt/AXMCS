import { AppError } from "../lib/errors.ts";
import type { AuthContext } from "./sessions.ts";
import type { User } from "../generated/prisma/client.ts";

/** Throws UNAUTHORIZED when nobody is signed in. */
export function requireAuth(ctx: AuthContext | null | undefined): AuthContext {
  if (!ctx) throw new AppError("UNAUTHORIZED", "Please sign in");
  return ctx;
}

/** Signed in AND the Minecraft account is linked (required before buying anything). */
export function requireLinked(ctx: AuthContext | null | undefined): AuthContext {
  const c = requireAuth(ctx);
  if (c.user.status !== "ACTIVE") {
    throw new AppError("ACCOUNT_NOT_LINKED", "Link your Minecraft account in-game before using the shop");
  }
  return c;
}

/** Every admin endpoint starts here. Roles are read from the database on each request. */
export function requireAdmin(ctx: AuthContext | null | undefined): AuthContext {
  const c = requireLinked(ctx);
  if (c.user.role !== "ADMIN") throw new AppError("FORBIDDEN", "Administrator access required");
  return c;
}

export function isAdmin(user: Pick<User, "role" | "status">): boolean {
  return user.role === "ADMIN" && user.status === "ACTIVE";
}
