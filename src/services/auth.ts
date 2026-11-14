import type { Db, Tx } from "../lib/db.ts";
import { isUniqueViolation } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import { consume } from "../lib/rate-limit.ts";
import { dummyHash, hashPassword, verifyPassword } from "../lib/password.ts";
import { newPasswordSchema, parse, registerSchema } from "../lib/validation.ts";
import { generateLinkCode, hashLinkCode, LINK_CODE_TTL_MS, normalizeLinkCode } from "./link-codes.ts";
import { createSession, revokeAllSessions, type CreatedSession } from "./sessions.ts";
import type { LinkPurpose, User } from "../generated/prisma/client.ts";

/** An unlinked registration reserves its username for this long, then the name is released. */
export const PENDING_CLAIM_TTL_MS = 60 * 60 * 1000;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const GENERIC_LOGIN_ERROR = "Invalid username or password";

export type SafeUser = Omit<User, "passwordHash">;
export function toSafeUser(u: User): SafeUser {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}

interface Ctx { ip?: string | null; userAgent?: string | null; now?: Date }

/** Replaces any unconsumed code of this purpose for the user with a fresh one. Returns the plaintext once. */
async function issueCode(tx: Tx, userId: string, purpose: LinkPurpose, now: Date): Promise<{ code: string; expiresAt: Date }> {
  await tx.linkCode.deleteMany({ where: { userId, purpose } });
  const code = generateLinkCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  await tx.linkCode.create({ data: { userId, purpose, codeHash: hashLinkCode(code), expiresAt, createdAt: now } });
  return { code, expiresAt };
}

// ─────────────────────────── Registration ───────────────────────────

export interface RegisterResult {
  user: SafeUser;
  /** Shown to the player once. They type `/rconfirmT <code>` in-game to prove they own the username. */
  linkCode: string;
  linkCodeExpiresAt: Date;
  session: CreatedSession;
}

export async function registerUser(db: Db, input: unknown, ctx: Ctx = {}): Promise<RegisterResult> {
  const now = ctx.now ?? new Date();
  const data = parse(registerSchema, input);
  const ip = ctx.ip ?? "unknown";
  await consume(db, `register:ip:${ip}`, 5, 3600, now);

  const passwordHash = await hashPassword(data.password);
  const lower = data.minecraftUsername.toLowerCase();
  const taken = new AppError("VALIDATION", "That Minecraft username is already registered", {
    fields: { minecraftUsername: "That Minecraft username is already registered" },
  });

  let created: { user: User; code: string; expiresAt: Date };
  try {
    created = await db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { minecraftUsernameLower: lower } });
      if (existing) {
        // A claim that was never confirmed in-game expires, so nobody can squat a username forever.
        const stale = existing.status === "PENDING_LINK" && existing.linkDeadline !== null && existing.linkDeadline <= now;
        if (!stale) throw taken;
        await tx.user.delete({ where: { id: existing.id } });
      }
      const user = await tx.user.create({
        data: {
          displayName: data.displayName,
          minecraftUsername: data.minecraftUsername,
          minecraftUsernameLower: lower,
          accountType: data.accountType,
          passwordHash,
          linkDeadline: new Date(now.getTime() + PENDING_CLAIM_TTL_MS),
          createdAt: now,
        },
      });
      const { code, expiresAt } = await issueCode(tx, user.id, "LINK", now);
      return { user, code, expiresAt };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw taken;
    throw e;
  }

  const session = await createSession(db, { userId: created.user.id, ip: ctx.ip, userAgent: ctx.userAgent, now });
  return { user: toSafeUser(created.user), linkCode: created.code, linkCodeExpiresAt: created.expiresAt, session };
}

/** For a registered but not yet linked player: a fresh code (the old one is invalidated). */
export async function reissueLinkCode(db: Db, userId: string, ctx: Ctx = {}): Promise<{ linkCode: string; expiresAt: Date }> {
  const now = ctx.now ?? new Date();
  await consume(db, `linkcode:user:${userId}`, 10, 3600, now);
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("NOT_FOUND", "Account not found");
    if (user.status !== "PENDING_LINK") throw new AppError("INVALID_STATE", "This account is already linked");
    await tx.user.update({ where: { id: userId }, data: { linkDeadline: new Date(now.getTime() + PENDING_CLAIM_TTL_MS) } });
    const { code, expiresAt } = await issueCode(tx, userId, "LINK", now);
    return { linkCode: code, expiresAt };
  });
}

// ─────────────────────────── Login ───────────────────────────

export interface LoginResult { user: SafeUser; session: CreatedSession }

export async function login(
  db: Db,
  input: { username: string; password: string },
  ctx: Ctx = {},
): Promise<LoginResult> {
  const now = ctx.now ?? new Date();
  const username = String(input.username ?? "").trim().toLowerCase().slice(0, 16);
  const password = String(input.password ?? "").slice(0, 256);
  await consume(db, `login:ip:${ctx.ip ?? "unknown"}`, 20, 600, now);
  await consume(db, `login:user:${username}`, 10, 600, now);

  const user = await db.user.findUnique({ where: { minecraftUsernameLower: username } });
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await dummyHash()), password);

  const locked = user?.lockedUntil != null && user.lockedUntil > now;
  if (!user || locked || user.status === "DISABLED" || !passwordOk) {
    if (user && !locked && user.status !== "DISABLED") await recordFailure(db, user, now);
    throw new AppError("UNAUTHORIZED", GENERIC_LOGIN_ERROR);
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });
  const session = await createSession(db, { userId: user.id, ip: ctx.ip, userAgent: ctx.userAgent, now });
  return { user: toSafeUser(updated), session };
}

async function recordFailure(db: Db, user: User, now: Date): Promise<void> {
  // Atomic increment; lock when the threshold is reached.
  const rows = await db.$queryRaw<{ failed_login_count: number }[]>`
    UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ${user.id}::uuid RETURNING failed_login_count`;
  if ((rows[0]?.failed_login_count ?? 0) >= MAX_FAILED_LOGINS) {
    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) },
    });
  }
}

// ─────────────────────────── Account settings ───────────────────────────

export async function changePassword(
  db: Db,
  p: { userId: string; currentPassword: string; newPassword: string; confirmPassword: string; keepSessionId?: string; now?: Date },
): Promise<void> {
  const now = p.now ?? new Date();
  const next = parse(newPasswordSchema, { password: p.newPassword, confirmPassword: p.confirmPassword });
  await consume(db, `chgpw:user:${p.userId}`, 5, 900, now);
  const user = await db.user.findUnique({ where: { id: p.userId } });
  if (!user) throw new AppError("NOT_FOUND", "Account not found");
  if (!(await verifyPassword(user.passwordHash, p.currentPassword))) {
    throw new AppError("VALIDATION", "Current password is incorrect", { fields: { currentPassword: "Current password is incorrect" } });
  }
  if (next.password.toLowerCase() === user.minecraftUsernameLower) {
    throw new AppError("VALIDATION", "Password must not be your username", { fields: { password: "Password must not be your username" } });
  }
  const passwordHash = await hashPassword(next.password);
  await db.user.update({ where: { id: user.id }, data: { passwordHash } });
  await revokeAllSessions(db, user.id, p.keepSessionId, now);
}

// ─────────────────────────── Password reset ───────────────────────────
//
// No email exists, so ownership is proven in-game:
//  1. The browser asks for a reset and is shown a code.
//  2. Only the real player can type `/rconfirmT <code>` as the account's own Minecraft UUID.
//  3. Once confirmed, the browser (the only party that knows the code) sets a new password.
// Requesting a reset for someone else's username gets an attacker a code they can never confirm.

export async function requestPasswordReset(
  db: Db,
  input: { username: string },
  ctx: Ctx = {},
): Promise<{ resetCode: string; expiresAt: Date }> {
  const now = ctx.now ?? new Date();
  const lower = String(input.username ?? "").trim().toLowerCase().slice(0, 16);
  await consume(db, `reset:ip:${ctx.ip ?? "unknown"}`, 5, 3600, now);
  await consume(db, `reset:user:${lower}`, 3, 3600, now);

  const user = await db.user.findUnique({ where: { minecraftUsernameLower: lower }, include: { minecraftAccount: true } });
  const eligible = user !== null && user.status === "ACTIVE" && user.minecraftAccount !== null;
  if (eligible) {
    return db.$transaction(async (tx) => {
      const { code, expiresAt } = await issueCode(tx, user.id, "RESET", now);
      return { resetCode: code, expiresAt };
    });
  }
  // Same response shape for unknown / unlinked names: nothing reveals whether the account exists.
  return { resetCode: generateLinkCode(), expiresAt: new Date(now.getTime() + LINK_CODE_TTL_MS) };
}

export type ResetStatus = "WAITING_FOR_GAME" | "CONFIRMED" | "INVALID";

/** The browser polls this while the player runs /rconfirmT in-game. */
export async function getResetStatus(db: Db, rawCode: string, now: Date = new Date()): Promise<ResetStatus> {
  let hash: string;
  try { hash = hashLinkCode(rawCode); } catch { return "INVALID"; }
  const row = await db.linkCode.findUnique({ where: { codeHash: hash } });
  if (!row || row.purpose !== "RESET" || row.expiresAt <= now) return "INVALID";
  return row.consumedAt ? "CONFIRMED" : "WAITING_FOR_GAME";
}

export async function completePasswordReset(
  db: Db,
  input: { code: string; password: string; confirmPassword: string },
  ctx: Ctx = {},
): Promise<void> {
  const now = ctx.now ?? new Date();
  const next = parse(newPasswordSchema, { password: input.password, confirmPassword: input.confirmPassword });
  await consume(db, `resetdone:ip:${ctx.ip ?? "unknown"}`, 10, 3600, now);
  const invalid = new AppError("VALIDATION", "This reset code is invalid, expired or not confirmed in-game yet");
  let hash: string;
  try { hash = hashLinkCode(normalizeLinkCode(input.code)); } catch { throw invalid; }
  const passwordHash = await hashPassword(next.password);

  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM link_codes WHERE code_hash = ${hash} FOR UPDATE`;
    const row = await tx.linkCode.findUnique({ where: { codeHash: hash }, include: { user: true } });
    if (!row || row.purpose !== "RESET" || row.expiresAt <= now || !row.consumedAt) throw invalid;
    if (row.user.status === "DISABLED") throw invalid;
    if (next.password.toLowerCase() === row.user.minecraftUsernameLower) {
      throw new AppError("VALIDATION", "Password must not be your username", { fields: { password: "Password must not be your username" } });
    }
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
    await tx.linkCode.deleteMany({ where: { userId: row.userId, purpose: "RESET" } }); // single use
    await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
  });
}
