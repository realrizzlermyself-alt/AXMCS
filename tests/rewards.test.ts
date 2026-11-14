import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, key, makeAccount, makeProduct, makeServer, type TestDb } from "./helpers/db.ts";
import { cancelPurchase, createPurchase } from "../src/services/purchases.ts";
import { ackReward, claimRewards, reapExpiredClaims, retryReward } from "../src/services/rewards.ts";
import { getBalance } from "../src/services/tokens.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

async function purchaseFor(opts: { commands?: string[]; balance?: number } = {}) {
  const account = await makeAccount(t.prisma, { balance: opts.balance ?? 100 });
  const product = await makeProduct(t.prisma, { price: 10, commands: opts.commands ?? ["give {player} diamond 1"] });
  const r = await createPurchase(t.prisma, { mcAccountId: account.id, productId: product.id, source: "WEB", idempotencyKey: key("buy") });
  return { account, product, purchase: r.purchase, reward: r.reward! };
}

const statusOf = async (purchaseId: string) => ({
  reward: (await t.prisma.rewardQueue.findUniqueOrThrow({ where: { purchaseId } })).status,
  purchase: (await t.prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } })).status,
});

describe("reward delivery", () => {
  it("keeps rewards queued for offline players and delivers when they are online", async () => {
    const s = await makeServer(t.prisma);
    const { account, purchase } = await purchaseFor();
    expect(await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [] })).toEqual([]);
    expect(await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: ["11111111-1111-4111-8111-111111111111"] })).toEqual([]);
    expect((await statusOf(purchase.id)).reward).toBe("PENDING");

    const claimed = await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid.toUpperCase()] });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ purchaseId: purchase.id, mcUuid: account.mcUuid, username: account.username, commandsCompleted: 0 });
    expect((await statusOf(purchase.id)).reward).toBe("CLAIMED");
  });

  it("marks the purchase delivered once the plugin confirms", async () => {
    const s = await makeServer(t.prisma);
    const { account, purchase, reward } = await purchaseFor({ commands: ["a {player}", "b {player}"] });
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    const ack = await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "DELIVERED" });
    expect(ack).toMatchObject({ replayed: false, status: "DELIVERED" });
    expect(await statusOf(purchase.id)).toEqual({ reward: "DELIVERED", purchase: "DELIVERED" });
    const row = await t.prisma.rewardQueue.findUniqueOrThrow({ where: { id: reward.id } });
    expect(row.commandsCompleted).toBe(2);
    expect(row.deliveredAt).not.toBeNull();
    // A repeated confirmation (e.g. the first response was lost) changes nothing.
    expect(await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "DELIVERED" })).toMatchObject({ replayed: true });
  });

  it("never hands a delivered reward out again", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward } = await purchaseFor();
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "DELIVERED" });
    for (let i = 0; i < 3; i++) {
      expect(await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] })).toEqual([]);
    }
  });

  it("gives a reward to only one server when two claim at the same moment", async () => {
    const a = await makeServer(t.prisma);
    const b = await makeServer(t.prisma);
    const { account } = await purchaseFor();
    const results = await Promise.all([
      claimRewards(t.prisma, { serverId: a.id, onlineMcUuids: [account.mcUuid] }),
      claimRewards(t.prisma, { serverId: b.id, onlineMcUuids: [account.mcUuid] }),
      claimRewards(t.prisma, { serverId: a.id, onlineMcUuids: [account.mcUuid] }),
      claimRewards(t.prisma, { serverId: b.id, onlineMcUuids: [account.mcUuid] }),
    ]);
    // Either server may win, but every returned copy belongs to the single winner.
    const serversHolding = await t.prisma.rewardQueue.findMany({ where: { mcAccountId: account.id } });
    expect(serversHolding).toHaveLength(1);
    const winner = serversHolding[0]!.claimedByServerId;
    expect(serversHolding[0]!.attempts).toBe(1);
    const claimedBy = [a.id, b.id, a.id, b.id];
    results.forEach((res, i) => {
      if (res.length > 0) expect(claimedBy[i]).toBe(winner);
    });
    expect(results.flat().length).toBeGreaterThanOrEqual(1);
  });

  it("returns the same reward again after a lost response, without counting a new attempt", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward } = await purchaseFor();
    const first = await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    const again = await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    expect(first.map((r) => r.rewardId)).toEqual([reward.id]);
    expect(again.map((r) => r.rewardId)).toEqual([reward.id]);
    expect((await t.prisma.rewardQueue.findUniqueOrThrow({ where: { id: reward.id } })).attempts).toBe(1);
  });

  it("does not let another server acknowledge a reward it did not claim", async () => {
    const a = await makeServer(t.prisma);
    const b = await makeServer(t.prisma);
    const { account, reward, purchase } = await purchaseFor();
    await claimRewards(t.prisma, { serverId: a.id, onlineMcUuids: [account.mcUuid] });
    await expect(ackReward(t.prisma, { rewardId: reward.id, serverId: b.id, outcome: "DELIVERED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await statusOf(purchase.id)).purchase).toBe("PENDING_DELIVERY");
  });

  it("records a failure, then lets an admin retry and resumes after the commands that already ran", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward, purchase } = await purchaseFor({ commands: ["one", "two", "three"] });
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "FAILED", commandsCompleted: 2, error: "Unknown command" });
    expect(await statusOf(purchase.id)).toEqual({ reward: "FAILED", purchase: "FAILED" });
    expect(await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] })).toEqual([]);

    await retryReward(t.prisma, { purchaseId: purchase.id });
    const [again] = await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    expect(again).toMatchObject({ rewardId: reward.id, commandsCompleted: 2, attempts: 2 });
  });

  it("sends uncertain deliveries to an admin instead of re-delivering", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward, purchase } = await purchaseFor();
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "UNCERTAIN", commandsCompleted: 0 });
    expect(await statusOf(purchase.id)).toEqual({ reward: "NEEDS_REVIEW", purchase: "NEEDS_REVIEW" });
    expect(await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] })).toEqual([]);
  });

  it("puts a reward back in the queue when the plugin says it never started", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward, purchase } = await purchaseFor();
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "RELEASED", commandsCompleted: 0 });
    expect((await statusOf(purchase.id)).reward).toBe("PENDING");
    expect(await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] })).toHaveLength(1);
  });

  it("does not re-queue a claim whose lease expired; it waits for review", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward, purchase } = await purchaseFor();
    const t0 = new Date("2026-11-09T10:00:00Z");
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid], leaseSeconds: 60, now: t0 });
    const later = new Date(t0.getTime() + 120_000);
    expect(await reapExpiredClaims(t.prisma, later)).toBe(1);
    expect(await statusOf(purchase.id)).toEqual({ reward: "NEEDS_REVIEW", purchase: "NEEDS_REVIEW" });
    expect(await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid], now: later })).toEqual([]);

    // The plugin's journal says it did deliver; that late report is accepted.
    await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "DELIVERED", now: later });
    expect(await statusOf(purchase.id)).toEqual({ reward: "DELIVERED", purchase: "DELIVERED" });
  });

  it("flags a delivery confirmed after the purchase was cancelled and refunded", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward, purchase } = await purchaseFor({ balance: 10 });
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid], leaseSeconds: 1, now: new Date("2026-01-01T00:00:00Z") });
    await reapExpiredClaims(t.prisma, new Date("2026-01-01T01:00:00Z"));
    await cancelPurchase(t.prisma, { purchaseId: purchase.id });
    expect(await getBalance(t.prisma, account.id)).toBe(10);
    const ack = await ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "DELIVERED" });
    expect(ack.warning).toMatch(/cancelled/);
    expect(await getBalance(t.prisma, account.id)).toBe(10);
  });

  it("validates progress reported by the plugin", async () => {
    const s = await makeServer(t.prisma);
    const { account, reward } = await purchaseFor({ commands: ["only"] });
    await claimRewards(t.prisma, { serverId: s.id, onlineMcUuids: [account.mcUuid] });
    await expect(ackReward(t.prisma, { rewardId: reward.id, serverId: s.id, outcome: "FAILED", commandsCompleted: 5 })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
