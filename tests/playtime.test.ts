import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, key, makeAccount, type TestDb } from "./helpers/db.ts";
import { recordPlaytime, type PlaytimeSubmission } from "../src/services/playtime.ts";
import { getBalance } from "../src/services/tokens.ts";
import {
  getEarningConfig, resolveEarningRate, setEarningFromAdmin,
} from "../src/services/settings.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

const NOW = new Date("2026-11-09T12:00:00Z");
const MIN = 60_000;

/** A period of `minutes` ending `endMinutesAgo` minutes before NOW. */
function period(minutes: number, endMinutesAgo = 0) {
  const end = new Date(NOW.getTime() - endMinutesAgo * MIN);
  return { periodStart: new Date(end.getTime() - minutes * MIN), periodEnd: end };
}

async function submit(accountId: string, o: Partial<PlaytimeSubmission> & { eligibleMinutes: number; minutes?: number; endMinutesAgo?: number }) {
  const { eligibleMinutes, minutes, endMinutesAgo, ...rest } = o;
  return recordPlaytime(t.prisma, {
    mcAccountId: accountId,
    idempotencyKey: key("pt"),
    eligibleSeconds: eligibleMinutes * 60,
    secondsPerToken: 3600,
    now: NOW,
    ...period(minutes ?? eligibleMinutes, endMinutesAgo ?? 0),
    ...rest,
  });
}

describe("token earning from playtime", () => {
  it("awards 1 token for 60 minutes", async () => {
    const a = await makeAccount(t.prisma);
    const r = await submit(a.id, { eligibleMinutes: 60 });
    expect(r.tokensAwarded).toBe(1);
    expect(r.balance).toBe(1);
    expect(r.carrySeconds).toBe(0);
    const tx = await t.prisma.tokenTransaction.findFirstOrThrow({ where: { mcAccountId: a.id } });
    expect(tx.type).toBe("PLAYTIME");
    expect(tx.amount).toBe(1);
  });

  it("awards nothing under an hour but remembers the time", async () => {
    const a = await makeAccount(t.prisma);
    const r = await submit(a.id, { eligibleMinutes: 59 });
    expect(r.tokensAwarded).toBe(0);
    expect(r.carrySeconds).toBe(59 * 60);
    expect(await getBalance(t.prisma, a.id)).toBe(0);
  });

  it("carries leftover time across submissions", async () => {
    const a = await makeAccount(t.prisma);
    const first = await submit(a.id, { eligibleMinutes: 90, endMinutesAgo: 120 });
    expect(first.tokensAwarded).toBe(1);
    expect(first.carrySeconds).toBe(30 * 60);
    const second = await submit(a.id, { eligibleMinutes: 30, endMinutesAgo: 0 });
    expect(second.tokensAwarded).toBe(1);
    expect(second.carrySeconds).toBe(0);
    expect(second.totalSeconds).toBe(120 * 60);
    expect(await getBalance(t.prisma, a.id)).toBe(2);
  });

  it("awards several tokens for a long block", async () => {
    const a = await makeAccount(t.prisma);
    const r = await submit(a.id, { eligibleMinutes: 185 });
    expect(r.tokensAwarded).toBe(3);
    expect(r.carrySeconds).toBe(5 * 60);
  });

  it("does not count AFK time", async () => {
    const a = await makeAccount(t.prisma);
    // 60 minutes online, 30 of them AFK => only 30 eligible minutes.
    const r = await submit(a.id, { eligibleMinutes: 30, minutes: 60, afkSeconds: 30 * 60 });
    expect(r.tokensAwarded).toBe(0);
    expect(r.totalSeconds).toBe(30 * 60);
    const rec = await t.prisma.playtimeRecord.findFirstOrThrow({ where: { mcAccountId: a.id } });
    expect(rec.afkSeconds).toBe(30 * 60);
  });

  it("honours a configurable rate", async () => {
    const a = await makeAccount(t.prisma);
    const r = await submit(a.id, { eligibleMinutes: 60, secondsPerToken: 1800 });
    expect(r.tokensAwarded).toBe(2);
  });

  it("never awards twice for a repeated submission", async () => {
    const a = await makeAccount(t.prisma);
    const k = key("pt");
    const p = period(60);
    const base = { mcAccountId: a.id, idempotencyKey: k, eligibleSeconds: 3600, secondsPerToken: 3600, now: NOW, ...p };
    const first = await recordPlaytime(t.prisma, base);
    const second = await recordPlaytime(t.prisma, base);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.tokensAwarded).toBe(1);
    expect(await getBalance(t.prisma, a.id)).toBe(1);
    expect(await t.prisma.playtimeRecord.count({ where: { mcAccountId: a.id } })).toBe(1);
  });

  it("never awards twice when the same submission arrives concurrently", async () => {
    const a = await makeAccount(t.prisma);
    const k = key("pt");
    const p = period(60);
    const base = { mcAccountId: a.id, idempotencyKey: k, eligibleSeconds: 3600, secondsPerToken: 3600, now: NOW, ...p };
    await Promise.all(Array.from({ length: 8 }, () => recordPlaytime(t.prisma, base)));
    expect(await getBalance(t.prisma, a.id)).toBe(1);
  });

  it("rejects the same stretch of time submitted under a different key", async () => {
    const a = await makeAccount(t.prisma);
    await submit(a.id, { eligibleMinutes: 60 });
    await expect(submit(a.id, { eligibleMinutes: 60, endMinutesAgo: 10 })).rejects.toMatchObject({ code: "OVERLAPPING_PERIOD" });
    expect(await getBalance(t.prisma, a.id)).toBe(1);
  });

  it("allows back-to-back periods", async () => {
    const a = await makeAccount(t.prisma);
    await submit(a.id, { eligibleMinutes: 30, endMinutesAgo: 30 });
    const r = await submit(a.id, { eligibleMinutes: 30, endMinutesAgo: 0 });
    expect(r.tokensAwarded).toBe(1);
  });

  it("rejects impossible reports", async () => {
    const a = await makeAccount(t.prisma);
    // More eligible time than the period contains.
    await expect(submit(a.id, { eligibleMinutes: 120, minutes: 60 })).rejects.toMatchObject({ code: "VALIDATION" });
    // Period in the future.
    await expect(submit(a.id, { eligibleMinutes: 10, endMinutesAgo: -60 })).rejects.toMatchObject({ code: "VALIDATION" });
    // Period longer than a day.
    await expect(submit(a.id, { eligibleMinutes: 10, minutes: 25 * 60 })).rejects.toMatchObject({ code: "VALIDATION" });
    // Negative / fractional seconds.
    await expect(recordPlaytime(t.prisma, { mcAccountId: a.id, idempotencyKey: key(), eligibleSeconds: -5, secondsPerToken: 3600, now: NOW, ...period(10) }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordPlaytime(t.prisma, { mcAccountId: a.id, idempotencyKey: key(), eligibleSeconds: 1.5, secondsPerToken: 3600, now: NOW, ...period(10) }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await getBalance(t.prisma, a.id)).toBe(0);
  });
});

describe("earning rate setting", () => {
  it("adopts the plugin's configured rate by default and stores it", async () => {
    const r = await resolveEarningRate(t.prisma, 1800);
    expect(r).toEqual({ secondsPerToken: 1800, changed: true });
    expect((await getEarningConfig(t.prisma)).secondsPerToken).toBe(1800);
  });

  it("lets the admin panel take over and ignore the plugin", async () => {
    await setEarningFromAdmin(t.prisma, { secondsPerToken: 7200, source: "admin" });
    const r = await resolveEarningRate(t.prisma, 1800);
    expect(r).toEqual({ secondsPerToken: 7200, changed: false });
  });

  it("rejects out-of-range rates", async () => {
    await expect(setEarningFromAdmin(t.prisma, { secondsPerToken: 10, source: "admin" })).rejects.toMatchObject({ code: "VALIDATION" });
    await setEarningFromAdmin(t.prisma, { secondsPerToken: 3600, source: "plugin" });
    await expect(resolveEarningRate(t.prisma, 5)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
