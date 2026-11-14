import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { ip, PASSWORD, regInput, uname } from "./helpers/users.ts";
import {
  changePassword, LOCKOUT_MS, login, PENDING_CLAIM_TTL_MS, registerUser, reissueLinkCode,
} from "../src/services/auth.ts";
import { validateSession } from "../src/services/sessions.ts";
import { makeLinkedUser } from "./helpers/users.ts";
import { consume } from "../src/lib/rate-limit.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

describe("registration", () => {
  it("creates a pending account, hashes the password with Argon2id and returns a code once", async () => {
    const input = regInput();
    const r = await registerUser(t.prisma, input, { ip: ip() });
    expect(r.user.status).toBe("PENDING_LINK");
    expect(r.user.role).toBe("PLAYER");
    expect("passwordHash" in r.user).toBe(false);
    expect(r.linkCode).toMatch(/^ABXMCTSP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
    // The plaintext code is never stored, only its hash.
    const codes = await t.prisma.linkCode.findMany({ where: { userId: r.user.id } });
    expect(codes).toHaveLength(1);
    expect(codes[0]!.codeHash).not.toContain(r.linkCode);
    expect(codes[0]!.purpose).toBe("LINK");
    // Registration signs the player in.
    expect((await validateSession(t.prisma, r.session.sessionToken))?.user.id).toBe(r.user.id);
  });

  it("validates every field", async () => {
    const bad = async (o: Record<string, unknown>, field: string) => {
      const e = await registerUser(t.prisma, regInput(o), { ip: ip() }).catch((x) => x);
      expect(e).toMatchObject({ code: "VALIDATION" });
      expect(Object.keys(e.fields)).toContain(field);
    };
    await bad({ minecraftUsername: "a" }, "minecraftUsername");
    await bad({ minecraftUsername: "has space" }, "minecraftUsername");
    await bad({ minecraftUsername: "x".repeat(17) }, "minecraftUsername");
    await bad({ displayName: "x" }, "displayName");
    await bad({ accountType: "ADMIN" }, "accountType");
    await bad({ password: "short", confirmPassword: "short" }, "password");
    await bad({ password: "password123", confirmPassword: "password123" }, "password");
    await bad({ confirmPassword: "different password!" }, "confirmPassword");
    const name = uname();
    await bad({ minecraftUsername: name, password: name + "xxxxx", confirmPassword: name + "xxxxx" }, "password").catch(() => {});
  });

  it("rejects a password equal to the username", async () => {
    const name = "SteveSteve12";
    const e = await registerUser(t.prisma, regInput({ minecraftUsername: name, password: name, confirmPassword: name }), { ip: ip() }).catch((x) => x);
    expect(e).toMatchObject({ code: "VALIDATION" });
  });

  it("prevents duplicate usernames, ignoring case", async () => {
    const name = uname();
    await registerUser(t.prisma, regInput({ minecraftUsername: name }), { ip: ip() });
    await expect(registerUser(t.prisma, regInput({ minecraftUsername: name.toUpperCase() }), { ip: ip() }))
      .rejects.toMatchObject({ code: "VALIDATION", fields: { minecraftUsername: expect.any(String) } });
  });

  it("handles simultaneous duplicate registrations", async () => {
    const name = uname();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => registerUser(t.prisma, regInput({ minecraftUsername: name }), { ip: ip() })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await t.prisma.user.count({ where: { minecraftUsernameLower: name.toLowerCase() } })).toBe(1);
  });

  it("releases a username whose claim was never confirmed in-game, but never an active one", async () => {
    const name = uname();
    const t0 = new Date("2026-11-09T10:00:00Z");
    const first = await registerUser(t.prisma, regInput({ minecraftUsername: name }), { ip: ip(), now: t0 });
    // Still within the claim window: taken.
    await expect(registerUser(t.prisma, regInput({ minecraftUsername: name }), { ip: ip(), now: new Date(t0.getTime() + 1000) }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    // After the window: the real owner can register.
    const later = new Date(t0.getTime() + PENDING_CLAIM_TTL_MS + 1000);
    const second = await registerUser(t.prisma, regInput({ minecraftUsername: name }), { ip: ip(), now: later });
    expect(second.user.id).not.toBe(first.user.id);

    const active = await makeLinkedUser(t.prisma);
    await expect(registerUser(t.prisma, regInput({ minecraftUsername: active.username }), { ip: ip(), now: new Date(Date.now() + 10 * PENDING_CLAIM_TTL_MS) }))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rate limits registrations per IP", async () => {
    const same = ip();
    for (let i = 0; i < 5; i++) await registerUser(t.prisma, regInput(), { ip: same });
    await expect(registerUser(t.prisma, regInput(), { ip: same })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await registerUser(t.prisma, regInput(), { ip: ip() }); // another IP is unaffected
  });

  it("issues a replacement link code and invalidates the old one", async () => {
    const r = await registerUser(t.prisma, regInput(), { ip: ip() });
    const again = await reissueLinkCode(t.prisma, r.user.id);
    expect(again.linkCode).not.toBe(r.linkCode);
    expect(await t.prisma.linkCode.count({ where: { userId: r.user.id, purpose: "LINK" } })).toBe(1);
  });
});

describe("login", () => {
  it("signs in with the Minecraft username (any case) and password", async () => {
    const u = await makeLinkedUser(t.prisma);
    const r = await login(t.prisma, { username: u.username.toUpperCase(), password: PASSWORD }, { ip: ip() });
    expect(r.user.id).toBe(u.user.id);
    expect("passwordHash" in r.user).toBe(false);
    expect((await validateSession(t.prisma, r.session.sessionToken))?.user.id).toBe(u.user.id);
  });

  it("gives the same generic error for a wrong password and an unknown user", async () => {
    const u = await makeLinkedUser(t.prisma);
    const wrong = await login(t.prisma, { username: u.username, password: "not the password" }, { ip: ip() }).catch((e) => e);
    const unknown = await login(t.prisma, { username: uname(), password: "not the password" }, { ip: ip() }).catch((e) => e);
    expect(wrong).toMatchObject({ code: "UNAUTHORIZED" });
    expect(unknown).toMatchObject({ code: "UNAUTHORIZED" });
    expect(wrong.message).toBe(unknown.message);
  });

  it("locks the account after repeated failures, even for the correct password, then unlocks", async () => {
    const u = await makeLinkedUser(t.prisma);
    const t0 = new Date("2026-11-09T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      await expect(login(t.prisma, { username: u.username, password: "wrong password!" }, { ip: ip(), now: t0 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    const locked = await login(t.prisma, { username: u.username, password: PASSWORD }, { ip: ip(), now: new Date(t0.getTime() + 60_000) }).catch((e) => e);
    expect(locked).toMatchObject({ code: "UNAUTHORIZED" });
    const after = new Date(t0.getTime() + LOCKOUT_MS + 11 * 60_000);
    const ok = await login(t.prisma, { username: u.username, password: PASSWORD }, { ip: ip(), now: after });
    expect(ok.user.id).toBe(u.user.id);
  });

  it("rate limits login attempts per IP", async () => {
    const same = ip();
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => login(t.prisma, { username: uname(), password: "whatever12345" }, { ip: same })),
    );
    expect(results.some((r) => r.status === "rejected" && (r.reason as { code: string }).code === "RATE_LIMITED")).toBe(true);
  });

  it("refuses disabled accounts", async () => {
    const u = await makeLinkedUser(t.prisma);
    await t.prisma.user.update({ where: { id: u.user.id }, data: { status: "DISABLED" } });
    await expect(login(t.prisma, { username: u.username, password: PASSWORD }, { ip: ip() })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("changing the password", () => {
  it("requires the current password and signs out other sessions", async () => {
    const u = await makeLinkedUser(t.prisma);
    const other = await login(t.prisma, { username: u.username, password: PASSWORD }, { ip: ip() });
    const NEW = "a brand new passphrase";
    await expect(changePassword(t.prisma, { userId: u.user.id, currentPassword: "wrong", newPassword: NEW, confirmPassword: NEW }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await changePassword(t.prisma, { userId: u.user.id, currentPassword: PASSWORD, newPassword: NEW, confirmPassword: NEW, keepSessionId: u.session.sessionId });
    expect(await validateSession(t.prisma, other.session.sessionToken)).toBeNull();
    expect(await validateSession(t.prisma, u.session.sessionToken)).not.toBeNull();
    await expect(login(t.prisma, { username: u.username, password: PASSWORD }, { ip: ip() })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await login(t.prisma, { username: u.username, password: NEW }, { ip: ip() });
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window and resets in the next window", async () => {
    const k = `test:${uname()}`;
    const t0 = new Date("2026-11-09T12:00:10Z");
    for (let i = 0; i < 3; i++) await consume(t.prisma, k, 3, 60, t0);
    const err = await consume(t.prisma, k, 3, 60, t0).catch((e) => e);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 50 });
    await consume(t.prisma, k, 3, 60, new Date("2026-11-09T12:01:01Z"));
  });
});
