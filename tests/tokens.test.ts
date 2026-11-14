import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, key, makeAccount, type TestDb } from "./helpers/db.ts";
import { changeTokens, getBalance, listTransactions, setTokens } from "../src/services/tokens.ts";
import { AppError } from "../src/lib/errors.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

describe("token balance changes", () => {
  it("credits and records a transaction with the resulting balance", async () => {
    const a = await makeAccount(t.prisma);
    const r = await changeTokens(t.prisma, { mcAccountId: a.id, amount: 5, type: "ADMIN_GIVE", idempotencyKey: key() });
    expect(r.applied).toBe(true);
    expect(r.balance).toBe(5);
    expect(r.transaction.balanceAfter).toBe(5);
    expect(await getBalance(t.prisma, a.id)).toBe(5);
  });

  it("debits, and refuses to go below zero without changing anything", async () => {
    const a = await makeAccount(t.prisma, { balance: 3 });
    await expect(
      changeTokens(t.prisma, { mcAccountId: a.id, amount: -4, type: "ADMIN_TAKE", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await getBalance(t.prisma, a.id)).toBe(3);
    expect(await t.prisma.tokenTransaction.count({ where: { mcAccountId: a.id } })).toBe(0);

    const ok = await changeTokens(t.prisma, { mcAccountId: a.id, amount: -3, type: "ADMIN_TAKE", idempotencyKey: key() });
    expect(ok.balance).toBe(0);
  });

  it("applies a repeated idempotency key only once", async () => {
    const a = await makeAccount(t.prisma);
    const k = key();
    const first = await changeTokens(t.prisma, { mcAccountId: a.id, amount: 7, type: "ADMIN_GIVE", idempotencyKey: k });
    const second = await changeTokens(t.prisma, { mcAccountId: a.id, amount: 7, type: "ADMIN_GIVE", idempotencyKey: k });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await getBalance(t.prisma, a.id)).toBe(7);
  });

  it("rejects an idempotency key reused for a different operation", async () => {
    const a = await makeAccount(t.prisma);
    const k = key();
    await changeTokens(t.prisma, { mcAccountId: a.id, amount: 7, type: "ADMIN_GIVE", idempotencyKey: k });
    await expect(
      changeTokens(t.prisma, { mcAccountId: a.id, amount: 8, type: "ADMIN_GIVE", idempotencyKey: k }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await getBalance(t.prisma, a.id)).toBe(7);
  });

  it("never overspends under concurrent debits", async () => {
    const a = await makeAccount(t.prisma, { balance: 10 });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        changeTokens(t.prisma, { mcAccountId: a.id, amount: -1, type: "ADMIN_TAKE", idempotencyKey: key() }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && (r.reason as AppError).code === "INSUFFICIENT_FUNDS",
    ).length;
    expect(ok).toBe(10);
    expect(refused).toBe(15);
    expect(await getBalance(t.prisma, a.id)).toBe(0);
  });

  it("applies one credit when the same key arrives concurrently", async () => {
    const a = await makeAccount(t.prisma);
    const k = key();
    await Promise.all(
      Array.from({ length: 10 }, () => changeTokens(t.prisma, { mcAccountId: a.id, amount: 4, type: "ADMIN_GIVE", idempotencyKey: k })),
    );
    expect(await getBalance(t.prisma, a.id)).toBe(4);
    expect(await t.prisma.tokenTransaction.count({ where: { idempotencyKey: k } })).toBe(1);
  });

  it("sets a balance as a single signed adjustment and is repeat-safe", async () => {
    const a = await makeAccount(t.prisma, { balance: 12 });
    const k = key();
    const r = await setTokens(t.prisma, { mcAccountId: a.id, target: 5, idempotencyKey: k });
    expect(r.transaction.amount).toBe(-7);
    expect(r.balance).toBe(5);
    const again = await setTokens(t.prisma, { mcAccountId: a.id, target: 5, idempotencyKey: k });
    expect(again.applied).toBe(false);
    expect(await getBalance(t.prisma, a.id)).toBe(5);
  });

  it("validates amounts and keys", async () => {
    const a = await makeAccount(t.prisma);
    await expect(changeTokens(t.prisma, { mcAccountId: a.id, amount: 1.5, type: "ADMIN_GIVE", idempotencyKey: key() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(changeTokens(t.prisma, { mcAccountId: a.id, amount: 5_000_000_000, type: "ADMIN_GIVE", idempotencyKey: key() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(changeTokens(t.prisma, { mcAccountId: a.id, amount: 1, type: "ADMIN_GIVE", idempotencyKey: "x" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(changeTokens(t.prisma, { mcAccountId: "00000000-0000-4000-8000-000000000000", amount: 1, type: "ADMIN_GIVE", idempotencyKey: key() }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists history newest first", async () => {
    const a = await makeAccount(t.prisma);
    for (const n of [1, 2, 3]) {
      await changeTokens(t.prisma, { mcAccountId: a.id, amount: n, type: "ADMIN_GIVE", idempotencyKey: key() });
    }
    const list = await listTransactions(t.prisma, a.id, { limit: 2 });
    expect(list.map((x) => x.amount)).toEqual([3, 2]);
  });

  it("is protected by database constraints even against raw SQL", async () => {
    const a = await makeAccount(t.prisma, { balance: 2 });
    await expect(
      t.prisma.$executeRaw`UPDATE token_balances SET balance = -1 WHERE mc_account_id = ${a.id}::uuid`,
    ).rejects.toThrow();
    expect(await getBalance(t.prisma, a.id)).toBe(2);
  });
});
