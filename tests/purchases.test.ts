import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, key, makeAccount, makeCategory, makeProduct, type TestDb } from "./helpers/db.ts";
import { cancelPurchase, createPurchase } from "../src/services/purchases.ts";
import { getBalance } from "../src/services/tokens.ts";
import { AppError } from "../src/lib/errors.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

const buy = (mcAccountId: string, productId: string, idempotencyKey = key("buy")) =>
  createPurchase(t.prisma, { mcAccountId, productId, source: "WEB", idempotencyKey });

describe("purchase processing", () => {
  it("charges the database price, snapshots the product and queues the reward", async () => {
    const a = await makeAccount(t.prisma, { balance: 50 });
    const p = await makeProduct(t.prisma, { price: 12, commands: ["lp user {player} parent add vip", "broadcast {player} is VIP"] });
    const r = await buy(a.id, p.id);

    expect(r.replayed).toBe(false);
    expect(r.balance).toBe(38);
    expect(await getBalance(t.prisma, a.id)).toBe(38);
    expect(r.purchase).toMatchObject({ unitPrice: 12, productName: p.name, status: "PENDING_DELIVERY", source: "WEB" });
    expect(r.reward).toMatchObject({ status: "PENDING", commands: p.commands, commandsCompleted: 0 });

    const tx = await t.prisma.tokenTransaction.findFirstOrThrow({ where: { purchaseId: r.purchase.id } });
    expect(tx).toMatchObject({ type: "PURCHASE", amount: -12, balanceAfter: 38 });
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockSold).toBe(1);
  });

  it("uses the current price at the time of purchase, and later edits never change what was bought", async () => {
    const a = await makeAccount(t.prisma, { balance: 100 });
    const p = await makeProduct(t.prisma, { price: 10, commands: ["give {player} apple 1"] });
    await t.prisma.product.update({ where: { id: p.id }, data: { price: 25 } });
    const r = await buy(a.id, p.id);
    expect(r.purchase.unitPrice).toBe(25);
    expect(r.balance).toBe(75);

    await t.prisma.product.update({ where: { id: p.id }, data: { price: 1, commands: ["op {player}"], name: "Renamed" } });
    const reward = await t.prisma.rewardQueue.findUniqueOrThrow({ where: { purchaseId: r.purchase.id } });
    const purchase = await t.prisma.purchase.findUniqueOrThrow({ where: { id: r.purchase.id } });
    expect(reward.commands).toEqual(["give {player} apple 1"]);
    expect(purchase.unitPrice).toBe(25);
    expect(purchase.productName).toBe(p.name);
  });

  it("rolls everything back when the player cannot afford it", async () => {
    const a = await makeAccount(t.prisma, { balance: 5 });
    const p = await makeProduct(t.prisma, { price: 6, stockLimit: 10 });
    await expect(buy(a.id, p.id)).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await getBalance(t.prisma, a.id)).toBe(5);
    expect(await t.prisma.purchase.count({ where: { mcAccountId: a.id } })).toBe(0);
    expect(await t.prisma.rewardQueue.count({ where: { mcAccountId: a.id } })).toBe(0);
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockSold).toBe(0);
  });

  it("is refused for disabled, deleted, empty-reward or disabled-category products", async () => {
    const a = await makeAccount(t.prisma, { balance: 100 });
    const disabled = await makeProduct(t.prisma, { enabled: false });
    const deleted = await makeProduct(t.prisma);
    await t.prisma.product.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    const noCommands = await makeProduct(t.prisma, { commands: [] });
    const offCat = await makeProduct(t.prisma, { categoryId: (await makeCategory(t.prisma, { enabled: false })).id });
    for (const p of [disabled, deleted, noCommands, offCat]) {
      await expect(buy(a.id, p.id)).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
    }
    await expect(buy(a.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
    expect(await getBalance(t.prisma, a.id)).toBe(100);
  });

  it("enforces a per-player limit", async () => {
    const a = await makeAccount(t.prisma, { balance: 100 });
    const p = await makeProduct(t.prisma, { price: 1, perPlayerLimit: 1 });
    await buy(a.id, p.id);
    await expect(buy(a.id, p.id)).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    expect(await getBalance(t.prisma, a.id)).toBe(99);
  });
});

describe("duplicate purchase prevention", () => {
  it("returns the original purchase for a repeated request and charges once", async () => {
    const a = await makeAccount(t.prisma, { balance: 30 });
    const p = await makeProduct(t.prisma, { price: 10, stockLimit: 5 });
    const k = key("dup");
    const first = await buy(a.id, p.id, k);
    const second = await buy(a.id, p.id, k);
    expect(second.replayed).toBe(true);
    expect(second.purchase.id).toBe(first.purchase.id);
    expect(await getBalance(t.prisma, a.id)).toBe(20);
    expect(await t.prisma.purchase.count({ where: { mcAccountId: a.id } })).toBe(1);
    expect(await t.prisma.rewardQueue.count({ where: { mcAccountId: a.id } })).toBe(1);
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockSold).toBe(1);
  });

  it("charges once when the same request is sent many times at once", async () => {
    const a = await makeAccount(t.prisma, { balance: 100 });
    const p = await makeProduct(t.prisma, { price: 10, stockLimit: 20 });
    const k = key("race");
    const results = await Promise.all(Array.from({ length: 12 }, () => buy(a.id, p.id, k)));
    expect(new Set(results.map((r) => r.purchase.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await getBalance(t.prisma, a.id)).toBe(90);
    expect(await t.prisma.rewardQueue.count({ where: { mcAccountId: a.id } })).toBe(1);
  });

  it("rejects a key reused for a different product or by a different player", async () => {
    const a = await makeAccount(t.prisma, { balance: 100 });
    const b = await makeAccount(t.prisma, { balance: 100 });
    const p1 = await makeProduct(t.prisma, { price: 1 });
    const p2 = await makeProduct(t.prisma, { price: 1 });
    const k = key("reuse");
    await buy(a.id, p1.id, k);
    await expect(buy(a.id, p2.id, k)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(buy(b.id, p1.id, k)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await getBalance(t.prisma, b.id)).toBe(100);
  });

  it("cannot be double-spent by two different purchases racing for the last tokens", async () => {
    const a = await makeAccount(t.prisma, { balance: 10 });
    const p = await makeProduct(t.prisma, { price: 10 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => buy(a.id, p.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getBalance(t.prisma, a.id)).toBe(0);
  });

  it("sells exactly the stock available under heavy concurrency", async () => {
    const p = await makeProduct(t.prisma, { price: 1, stockLimit: 3 });
    const buyers = await Promise.all(Array.from({ length: 10 }, () => makeAccount(t.prisma, { balance: 5 })));
    const results = await Promise.allSettled(buyers.map((b) => buy(b.id, p.id)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const soldOut = results.filter((r) => r.status === "rejected" && (r.reason as AppError).code === "OUT_OF_STOCK").length;
    expect(ok).toBe(3);
    expect(soldOut).toBe(7);
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockSold).toBe(3);
    // Losers keep their tokens.
    const balances = await Promise.all(buyers.map((b) => getBalance(t.prisma, b.id)));
    expect(balances.filter((x) => x === 4)).toHaveLength(3);
    expect(balances.filter((x) => x === 5)).toHaveLength(7);
  });
});

describe("cancelling a purchase", () => {
  it("refunds exactly once, restores stock and cancels the reward", async () => {
    const a = await makeAccount(t.prisma, { balance: 20 });
    const p = await makeProduct(t.prisma, { price: 8, stockLimit: 2 });
    const { purchase } = await buy(a.id, p.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => cancelPurchase(t.prisma, { purchaseId: purchase.id, reason: "test" })));
    expect(results.filter((r) => r.cancelled)).toHaveLength(1);
    expect(await getBalance(t.prisma, a.id)).toBe(20);
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockSold).toBe(0);
    expect((await t.prisma.rewardQueue.findUniqueOrThrow({ where: { purchaseId: purchase.id } })).status).toBe("CANCELLED");
    expect((await t.prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe("CANCELLED");
    expect(await t.prisma.tokenTransaction.count({ where: { purchaseId: purchase.id, type: "REFUND" } })).toBe(1);
  });

  it("refuses to cancel a delivered purchase", async () => {
    const a = await makeAccount(t.prisma, { balance: 20 });
    const p = await makeProduct(t.prisma, { price: 8 });
    const { purchase } = await buy(a.id, p.id);
    await t.prisma.rewardQueue.update({ where: { purchaseId: purchase.id }, data: { status: "DELIVERED" } });
    await t.prisma.purchase.update({ where: { id: purchase.id }, data: { status: "DELIVERED" } });
    await expect(cancelPurchase(t.prisma, { purchaseId: purchase.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await getBalance(t.prisma, a.id)).toBe(12);
  });

  it("refuses to cancel while a delivery is in flight", async () => {
    const a = await makeAccount(t.prisma, { balance: 20 });
    const p = await makeProduct(t.prisma, { price: 8 });
    const { purchase } = await buy(a.id, p.id);
    await t.prisma.rewardQueue.update({
      where: { purchaseId: purchase.id },
      data: { status: "CLAIMED", leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(cancelPurchase(t.prisma, { purchaseId: purchase.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await getBalance(t.prisma, a.id)).toBe(12);
  });
});
