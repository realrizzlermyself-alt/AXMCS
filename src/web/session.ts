import { cookies, headers } from "next/headers";
import { getPrisma } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import { assertCsrf, clearSessionCookie, validateSession, type AuthContext } from "../services/sessions.ts";

const secure = () => process.env.NODE_ENV === "production";
export const SESSION_COOKIE = () => (secure() ? "__Host-ts_session" : "ts_session");
export const CSRF_COOKIE = () => (secure() ? "__Host-ts_csrf" : "ts_csrf");
export const FLASH_COOKIE = "ts_flash";

export async function currentAuth(): Promise<AuthContext | null> {
  const jar = await cookies();
  return validateSession(getPrisma(), jar.get(SESSION_COOKIE())?.value);
}

export async function csrfToken(): Promise<string> {
  return (await cookies()).get(CSRF_COOKIE())?.value ?? "";
}

export async function setSessionCookies(session: { sessionToken: string; csrfToken: string; expiresAt: Date }) {
  const jar = await cookies();
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: secure(), path: "/", expires: session.expiresAt };
  jar.set(SESSION_COOKIE(), session.sessionToken, opts);
  jar.set(CSRF_COOKIE(), session.csrfToken, opts);
}

export async function clearSessionCookies() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE());
  jar.delete(CSRF_COOKIE());
  void clearSessionCookie;
}

export async function clientContext(): Promise<{ ip: string; userAgent: string | null }> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
  return { ip, userAgent: h.get("user-agent") };
}

/** Every state-changing action with a signed-in user starts here: same-site Origin + per-session CSRF token. */
export async function guard(form: FormData): Promise<AuthContext> {
  const ctx = await currentAuth();
  if (!ctx) throw new AppError("UNAUTHORIZED", "Please sign in");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (secure() ? "https" : "http");
  const allowed = process.env.SITE_URL ?? `${proto}://${host}`;
  assertCsrf(ctx, { origin: h.get("origin"), referer: h.get("referer"), csrfToken: String(form.get("_csrf") ?? "") }, allowed);
  return ctx;
}

/** Message safe to show: AppError text, never internals. */
export function safeMessage(e: unknown): string {
  if (e instanceof AppError) return e.message;
  console.error(e);
  return "Something went wrong. Please try again.";
}
