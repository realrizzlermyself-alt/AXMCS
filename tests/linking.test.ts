import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { ip, makeLinkedUser, PASSWORD, regInput, uname } from "./helpers/users.ts";
import {
  completePasswordReset, getResetStatus, login, registerUser, requestPasswordReset,
} from "../src/services/auth.ts";
import { confirmInGame } from "../src/services/linking.ts";
import { generateLinkCode, hashLinkCode, LINK_CODE_TTL_MS, normalizeLinkCode } from "../src/services/link-codes.ts";
import { changeTokens, getBalance } from "../src/services/tokens.ts";
import { ensureMinecraftAccount } from "../src/services/accounts.ts";
import { validateSession } from "../src/services/sessions.ts";
import { requireLinked } from "../src/services/authz.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

const register = (o: Record<string, unknown> = {}) => {
  const input = regInput(o);
  return registerUser(t.prisma, input, { ip: ip() }).then((r) => ({ ...r, username: input.minecraftUsername }));
};

describe("link codes", () => {
  it("are random, well formed and tolerant of how people type them", () => {
    const codes = new Set(Array.from({ length: 200 }, generateLinkCode));
    expect(codes.size).toBe(200);
    const c = generateLinkCode();
    expect(c.startsWith("ABXMCTSP-")).toBe(true);
    expect(normalizeLinkCode(c.toLowerCase().replace(/-/g, " "))).toBe(c);
    expect(normalizeLinkCode(`  ${c}  `)).toBe(c);
    expect(hashLinkCode(c.toLowerCase())).toBe(hashLinkCode(c));
  });

  it("reject anything that is not a code", () => {
    for (const bad of ["", "hello", "ABXMCTSP", "ABXMCTSP-1234", "XXXXXXXX-AAAA-BBBB-CCCC", "ABXMCTSP-AAAA-BBBB-CCC0", "ABXMCTSP-AAAA-BBBB-CCCCD"]) {
      expect(() => normalizeLinkCode(bad)).toThrow();
    }
  });
});

describe("account linking via /rconfirmT", () => {
  it("links the account, activates the user and keeps tokens earned before registering", async () => {
    const mcUuid = randomUUID();
    const name = uname();
    // The player has been playing for a while without a website account.
    const acct = await ensureMinecraftAccount(t.prisma, { mcUuid, username: name });
    await changeTokens(t.prisma, { mcAccountId: acct.id, amount: 7, type: "PLAYTIME", idempotencyKey: `pt-${randomUUID()}` });

    const reg = await register({ minecraftUsername: name });
    const out = await confirmInGame(t.prisma, { mcUuid, username: name, onlineMode: false, code: reg.linkCode });
    expect(out).toMatchObject({ kind: "LINKED", accountType: "OFFLINE" });

    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: reg.user.id } });
    expect(user.status).toBe("ACTIVE");
    expect(user.linkDeadline).toBeNull();
    const linked = await t.prisma.minecraftAccount.findUniqueOrThrow({ where: { userId: user.id } });
    expect(linked.id).toBe(acct.id);
    expect(linked.mcUuid).toBe(mcUuid);
    expect(await getBalance(t.prisma, linked.id)).toBe(7);
    expect(await t.prisma.linkCode.count({ where: { userId: user.id } })).toBe(0);
  });

  it("accepts a code typed in lower case without dashes", async () => {
    const reg = await register();
    const typed = reg.linkCode.toLowerCase().replace(/-/g, "");
    const out = await confirmInGame(t.prisma, { mcUuid: randomUUID(), username: reg.username.toUpperCase(), onlineMode: false, code: typed });
    expect(out.kind).toBe("LINKED");
  });

  it("only works once", async () => {
    const reg = await register();
    const args = { mcUuid: randomUUID(), username: reg.username, onlineMode: false, code: reg.linkCode };
    await confirmInGame(t.prisma, args);
    await expect(confirmInGame(t.prisma, args)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("links exactly once when the same code is submitted concurrently", async () => {
    const reg = await register();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => confirmInGame(t.prisma, { mcUuid: randomUUID(), username: reg.username, onlineMode: false, code: reg.linkCode })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await t.prisma.minecraftAccount.count({ where: { userId: reg.user.id } })).toBe(1);
  });

  it("refuses a player who is not the registered username", async () => {
    const reg = await register();
    await expect(confirmInGame(t.prisma, { mcUuid: randomUUID(), username: uname(), onlineMode: false, code: reg.linkCode }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: reg.user.id } })).status).toBe("PENDING_LINK");
  });

  it("refuses unknown and expired codes", async () => {
    await expect(confirmInGame(t.prisma, { mcUuid: randomUUID(), username: uname(), onlineMode: false, code: generateLinkCode() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    const reg = await register();
    await expect(confirmInGame(t.prisma, {
      mcUuid: randomUUID(), username: reg.username, onlineMode: false, code: reg.linkCode,
      now: new Date(Date.now() + LINK_CODE_TTL_MS + 5000),
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a Minecraft account that belongs to another website account", async () => {
    const first = await makeLinkedUser(t.prisma);
    const second = await register();
    await expect(confirmInGame(t.prisma, { mcUuid: first.mcUuid, username: second.username, onlineMode: false, code: second.linkCode }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: second.user.id } })).status).toBe("PENDING_LINK");
  });

  it("verifies Premium accounts only on a Mojang-authenticated (online-mode) server", async () => {
    const reg = await register({ accountType: "PREMIUM" });
    const mcUuid = randomUUID();
    await expect(confirmInGame(t.prisma, { mcUuid, username: reg.username, onlineMode: false, code: reg.linkCode }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: reg.user.id } })).status).toBe("PENDING_LINK");
    const ok = await confirmInGame(t.prisma, { mcUuid, username: reg.username, onlineMode: true, code: reg.linkCode });
    expect(ok).toMatchObject({ kind: "LINKED", accountType: "PREMIUM" });
    const linked = await t.prisma.minecraftAccount.findUniqueOrThrow({ where: { mcUuid } });
    expect(linked).toMatchObject({ accountType: "PREMIUM", onlineModeVerified: true });
  });

  it("rate limits code guessing per player", async () => {
    const mcUuid = randomUUID();
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await confirmInGame(t.prisma, { mcUuid, username: uname(), onlineMode: false, code: generateLinkCode() }).catch((e) => e));
    }
    expect(results.slice(0, 10).every((r) => r.code === "VALIDATION")).toBe(true);
    expect(results[10]).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("keeps the shop closed until the account is linked", async () => {
    const reg = await register();
    const pending = await validateSession(t.prisma, reg.session.sessionToken);
    expect(() => requireLinked(pending)).toThrowError(expect.objectContaining({ code: "ACCOUNT_NOT_LINKED" }));
    await confirmInGame(t.prisma, { mcUuid: randomUUID(), username: reg.username, onlineMode: false, code: reg.linkCode });
    expect(requireLinked(await validateSession(t.prisma, reg.session.sessionToken)).user.status).toBe("ACTIVE");
  });
});

describe("password reset via /rconfirmT", () => {
  const NEW = "my shiny new passphrase";

  it("requires confirmation in-game by the account's own Minecraft UUID", async () => {
    const u = await makeLinkedUser(t.prisma);
    const { resetCode } = await requestPasswordReset(t.prisma, { username: u.username }, { ip: ip() });
    expect(await getResetStatus(t.prisma, resetCode)).toBe("WAITING_FOR_GAME");

    // Not confirmed yet: cannot reset.
    await expect(completePasswordReset(t.prisma, { code: resetCode, password: NEW, confirmPassword: NEW }, { ip: ip() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    // Someone else's Minecraft account cannot confirm it.
    await expect(confirmInGame(t.prisma, { mcUuid: randomUUID(), username: u.username, onlineMode: false, code: resetCode }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await getResetStatus(t.prisma, resetCode)).toBe("WAITING_FOR_GAME");

    // The real player confirms.
    const out = await confirmInGame(t.prisma, { mcUuid: u.mcUuid, username: u.username, onlineMode: false, code: resetCode });
    expect(out.kind).toBe("RESET_CONFIRMED");
    expect(await getResetStatus(t.prisma, resetCode)).toBe("CONFIRMED");

    const active = await login(t.prisma, { username: u.username, password: PASSWORD }, { ip: ip() });
    await completePasswordReset(t.prisma, { code: resetCode, password: NEW, confirmPassword: NEW }, { ip: ip() });

    // New password works, old one does not, all sessions are signed out.
    await login(t.prisma, { username: u.username, password: NEW }, { ip: ip() });
    await expect(login(t.prisma, { username: u.username, password: PASSWORD }, { ip: ip() })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await validateSession(t.prisma, active.session.sessionToken)).toBeNull();
    expect(await validateSession(t.prisma, u.session.sessionToken)).toBeNull();
    // Single use.
    await expect(completePasswordReset(t.prisma, { code: resetCode, password: "another passphrase!", confirmPassword: "another passphrase!" }, { ip: ip() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await getResetStatus(t.prisma, resetCode)).toBe("INVALID");
  });

  it("gives no hint whether an account exists", async () => {
    const r = await requestPasswordReset(t.prisma, { username: uname() }, { ip: ip() });
    expect(r.resetCode).toMatch(/^ABXMCTSP-/);
    expect(await getResetStatus(t.prisma, r.resetCode)).toBe("INVALID");
    // Unlinked accounts get the same treatment.
    const pending = await register();
    const p = await requestPasswordReset(t.prisma, { username: pending.username }, { ip: ip() });
    expect(await getResetStatus(t.prisma, p.resetCode)).toBe("INVALID");
  });

  it("keeps only the latest reset code, and codes expire", async () => {
    const u = await makeLinkedUser(t.prisma);
    const a = await requestPasswordReset(t.prisma, { username: u.username }, { ip: ip() });
    const b = await requestPasswordReset(t.prisma, { username: u.username }, { ip: ip() });
    expect(await getResetStatus(t.prisma, a.resetCode)).toBe("INVALID");
    expect(await getResetStatus(t.prisma, b.resetCode)).toBe("WAITING_FOR_GAME");
    expect(await getResetStatus(t.prisma, b.resetCode, new Date(Date.now() + LINK_CODE_TTL_MS + 5000))).toBe("INVALID");
  });

  it("rate limits reset requests per username", async () => {
    const u = await makeLinkedUser(t.prisma);
    for (let i = 0; i < 3; i++) await requestPasswordReset(t.prisma, { username: u.username }, { ip: ip() });
    await expect(requestPasswordReset(t.prisma, { username: u.username }, { ip: ip() })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not let a link code be used as a reset code or the reverse", async () => {
    const reg = await register();
    await expect(completePasswordReset(t.prisma, { code: reg.linkCode, password: NEW, confirmPassword: NEW }, { ip: ip() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await getResetStatus(t.prisma, reg.linkCode)).toBe("INVALID");
  });
});
