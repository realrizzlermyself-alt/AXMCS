import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { makeLinkedUser } from "./helpers/users.ts";
import {
  assertCsrf, clearSessionCookie, createSession, revokeAllSessions, revokeSession, SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS, sessionCookie, sha256, validateSession, verifyCsrf,
} from "../src/services/sessions.ts";
import { isAdmin, requireAdmin, requireAuth, requireLinked } from "../src/services/authz.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

const DAY = 24 * 3600 * 1000;

describe("sessions", () => {
  it("stores only hashes of the session and CSRF tokens", async () => {
    const u = await makeLinkedUser(t.prisma);
    const s = await createSession(t.prisma, { userId: u.user.id });
    const row = await t.prisma.session.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(row.tokenHash).toBe(sha256(s.sessionToken));
    expect(row.csrfHash).toBe(sha256(s.csrfToken));
    expect(JSON.stringify(row)).not.toContain(s.sessionToken);
    expect(s.sessionToken.length).toBeGreaterThanOrEqual(40);
  });

  it("rejects junk, unknown, revoked and idle-expired tokens", async () => {
    const u = await makeLinkedUser(t.prisma);
    const t0 = new Date("2026-11-09T10:00:00Z");
    const s = await createSession(t.prisma, { userId: u.user.id, now: t0 });
    expect(await validateSession(t.prisma, undefined)).toBeNull();
    expect(await validateSession(t.prisma, "")).toBeNull();
    expect(await validateSession(t.prisma, "x".repeat(50))).toBeNull();
    expect(await validateSession(t.prisma, s.sessionToken, new Date(t0.getTime() + DAY))).not.toBeNull();

    // A session nobody touched for longer than the idle window is dead.
    const idle = await createSession(t.prisma, { userId: u.user.id, now: t0 });
    expect(await validateSession(t.prisma, idle.sessionToken, new Date(t0.getTime() + SESSION_IDLE_MS + 1000))).toBeNull();

    const s2 = await createSession(t.prisma, { userId: u.user.id });
    await revokeSession(t.prisma, s2.sessionId);
    expect(await validateSession(t.prisma, s2.sessionToken)).toBeNull();
  });

  it("slides the idle window but never past the absolute lifetime", async () => {
    const u = await makeLinkedUser(t.prisma);
    const t0 = new Date("2026-11-09T10:00:00Z");
    const s = await createSession(t.prisma, { userId: u.user.id, now: t0 });
    let last = null;
    for (let d = 5; d <= 28; d += 5) last = await validateSession(t.prisma, s.sessionToken, new Date(t0.getTime() + d * DAY));
    expect(last).not.toBeNull();
    expect(last!.session.expiresAt.getTime()).toBeLessThanOrEqual(t0.getTime() + SESSION_ABSOLUTE_MS);
    expect(await validateSession(t.prisma, s.sessionToken, new Date(t0.getTime() + SESSION_ABSOLUTE_MS + 1000))).toBeNull();
  });

  it("stops working when the account is disabled, and can sign out everywhere", async () => {
    const u = await makeLinkedUser(t.prisma);
    const a = await createSession(t.prisma, { userId: u.user.id });
    const b = await createSession(t.prisma, { userId: u.user.id });
    expect(await revokeAllSessions(t.prisma, u.user.id, a.sessionId)).toBeGreaterThanOrEqual(1);
    expect(await validateSession(t.prisma, a.sessionToken)).not.toBeNull();
    expect(await validateSession(t.prisma, b.sessionToken)).toBeNull();
    await t.prisma.user.update({ where: { id: u.user.id }, data: { status: "DISABLED" } });
    expect(await validateSession(t.prisma, a.sessionToken)).toBeNull();
  });
});

describe("CSRF protection", () => {
  it("checks the token in constant time against the stored hash", async () => {
    const u = await makeLinkedUser(t.prisma);
    const s = await createSession(t.prisma, { userId: u.user.id });
    const row = await t.prisma.session.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(verifyCsrf(row, s.csrfToken)).toBe(true);
    expect(verifyCsrf(row, s.csrfToken + "x")).toBe(false);
    expect(verifyCsrf(row, "")).toBe(false);
    expect(verifyCsrf(row, null)).toBe(false);
    expect(verifyCsrf(row, s.sessionToken)).toBe(false); // the session token is not a CSRF token
  });

  it("requires both a same-site origin and a valid token", async () => {
    const u = await makeLinkedUser(t.prisma);
    const s = await createSession(t.prisma, { userId: u.user.id });
    const ctx = (await validateSession(t.prisma, s.sessionToken))!;
    const site = "https://store.example.com";
    expect(() => assertCsrf(ctx, { origin: site, csrfToken: s.csrfToken }, site)).not.toThrow();
    expect(() => assertCsrf(ctx, { referer: `${site}/shop/1`, csrfToken: s.csrfToken }, site)).not.toThrow();
    const blocked = (r: Parameters<typeof assertCsrf>[1]) => expect(() => assertCsrf(ctx, r, site)).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    blocked({ origin: "https://evil.example.net", csrfToken: s.csrfToken });
    blocked({ origin: "https://store.example.com.evil.net", csrfToken: s.csrfToken });
    blocked({ csrfToken: s.csrfToken });
    blocked({ referer: "not a url", csrfToken: s.csrfToken });
    blocked({ origin: site });
    blocked({ origin: site, csrfToken: "wrong" });
  });

  it("builds hardened cookies", () => {
    const exp = new Date("2026-12-01T00:00:00Z");
    const prod = sessionCookie("tok", exp, true);
    expect(prod).toMatch(/^__Host-ts_session=tok;/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(prod).toContain(flag);
    expect(prod).not.toContain("Domain=");
    expect(sessionCookie("tok", exp, false)).not.toContain("Secure");
    expect(clearSessionCookie(true)).toContain("Max-Age=0");
  });
});

describe("authorization", () => {
  it("requires sign-in, a linked account and the admin role, in that order", async () => {
    const player = await makeLinkedUser(t.prisma);
    const ctx = (await validateSession(t.prisma, player.session.sessionToken))!;
    expect(() => requireAuth(null)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => requireLinked(null)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => requireAdmin(null)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(requireLinked(ctx)).toBe(ctx);
    expect(() => requireAdmin(ctx)).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    await t.prisma.user.update({ where: { id: player.user.id }, data: { role: "ADMIN" } });
    const asAdmin = (await validateSession(t.prisma, player.session.sessionToken))!;
    expect(requireAdmin(asAdmin).user.id).toBe(player.user.id);
    expect(isAdmin(asAdmin.user)).toBe(true);
  });

  it("applies a demotion immediately to sessions that are already open", async () => {
    const admin = await makeLinkedUser(t.prisma);
    await t.prisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
    expect(requireAdmin((await validateSession(t.prisma, admin.session.sessionToken))!)).toBeTruthy();
    await t.prisma.user.update({ where: { id: admin.user.id }, data: { role: "PLAYER" } });
    const again = (await validateSession(t.prisma, admin.session.sessionToken))!;
    expect(() => requireAdmin(again)).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("does not treat an unlinked admin as an admin", async () => {
    const u = await makeLinkedUser(t.prisma);
    await t.prisma.user.update({ where: { id: u.user.id }, data: { role: "ADMIN", status: "PENDING_LINK" } });
    const ctx = (await validateSession(t.prisma, u.session.sessionToken))!;
    expect(() => requireAdmin(ctx)).toThrowError(expect.objectContaining({ code: "ACCOUNT_NOT_LINKED" }));
    expect(isAdmin(ctx.user)).toBe(false);
  });
});
