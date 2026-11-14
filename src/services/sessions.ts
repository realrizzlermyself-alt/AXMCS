import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import type { Session, User } from "../generated/prisma/client.ts";

export const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 60_000;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const newToken = (): string => randomBytes(32).toString("base64url");

export interface AuthContext {
  user: User;
  session: Session;
}

export interface CreatedSession {
  /** Goes in the HttpOnly cookie. Only its hash is stored. */
  sessionToken: string;
  /** Sent with every state-changing request (header or form field). */
  csrfToken: string;
  expiresAt: Date;
  sessionId: string;
}

export async function createSession(
  db: Db,
  p: { userId: string; ip?: string | null; userAgent?: string | null; now?: Date },
): Promise<CreatedSession> {
  const now = p.now ?? new Date();
  const sessionToken = newToken();
  const csrfToken = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_IDLE_MS);
  const row = await db.session.create({
    data: {
      userId: p.userId,
      tokenHash: sha256(sessionToken),
      csrfHash: sha256(csrfToken),
      ip: p.ip?.slice(0, 64) ?? null,
      userAgent: p.userAgent?.slice(0, 255) ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    },
  });
  return { sessionToken, csrfToken, expiresAt, sessionId: row.id };
}

/** Returns the signed-in user for a session cookie, or null. Slides the idle expiry. */
export async function validateSession(db: Db, sessionToken: string | undefined | null, now: Date = new Date()): Promise<AuthContext | null> {
  if (!sessionToken || sessionToken.length < 20 || sessionToken.length > 128) return null;
  const session = await db.session.findUnique({ where: { tokenHash: sha256(sessionToken) }, include: { user: true } });
  if (!session) return null;
  const { user, ...s } = session;
  if (s.revokedAt || s.expiresAt <= now) return null;
  if (now.getTime() - s.createdAt.getTime() > SESSION_ABSOLUTE_MS) return null;
  if (user.status === "DISABLED") return null;

  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const absoluteEnd = s.createdAt.getTime() + SESSION_ABSOLUTE_MS;
    const expiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, absoluteEnd));
    const updated = await db.session.update({ where: { id: s.id }, data: { lastSeenAt: now, expiresAt } });
    return { user, session: updated };
  }
  return { user, session: s };
}

export async function revokeSession(db: Db, sessionId: string, now: Date = new Date()): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}

export async function revokeAllSessions(db: Db, userId: string, exceptSessionId?: string, now: Date = new Date()): Promise<number> {
  const r = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: now },
  });
  return r.count;
}

/** Constant-time check of the CSRF token against the session's stored hash. */
export function verifyCsrf(session: Pick<Session, "csrfHash">, token: string | undefined | null): boolean {
  if (!token || token.length > 128) return false;
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(session.csrfHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * CSRF defence in depth for cookie-authenticated state-changing requests:
 *  1. the request's Origin (or Referer) must be our own site, and
 *  2. the per-session CSRF token must match.
 * Both must pass. SameSite=Lax cookies are a third layer.
 */
export function assertCsrf(
  ctx: AuthContext,
  req: { origin?: string | null; referer?: string | null; csrfToken?: string | null },
  allowedOrigin: string,
): void {
  const allowed = new URL(allowedOrigin).origin;
  const source = req.origin ?? (req.referer ? safeOrigin(req.referer) : null);
  if (!source || source !== allowed) throw new AppError("FORBIDDEN", "Cross-site request blocked");
  if (!verifyCsrf(ctx.session, req.csrfToken)) throw new AppError("FORBIDDEN", "Invalid CSRF token");
}

function safeOrigin(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

/** Builds the Set-Cookie header value. `__Host-` prefix in production pins it to this exact origin. */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const name = secure ? "__Host-ts_session" : "ts_session";
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  const name = secure ? "__Host-ts_session" : "ts_session";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}

export async function purgeSessions(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  return (await db.session.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: cutoff } }] } })).count;
}
