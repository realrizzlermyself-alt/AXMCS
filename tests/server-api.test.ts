import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeAccount, makeCategory, makeProduct, type TestDb } from "./helpers/db.ts";
import { ip, regInput } from "./helpers/users.ts";
import { handleServerApi } from "../src/api/server-api.ts";
import { sign } from "../src/lib/server-auth.ts";
import { registerUser } from "../src/services/auth.ts";
import { getBalance } from "../src/services/tokens.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

const SECRET = randomBytes(32).toString("hex");
const BASE = "https://store.example.com";

interface Reply { status: number; ok: boolean; data?: any; error?: { code: string; message: string; fields?: any }; headers: Headers; requestId: string }

async function call(path: string, body: unknown, o: { secret?: string; server?: string; now?: Date; nonce?: string; method?: string; rawBody?: string } = {}): Promise<Reply> {
  const raw = o.rawBody ?? JSON.stringify(body);
  const now = o.now ?? new Date();
  const method = o.method ?? "POST";
  const server = o.server ?? "main";
  const nonce = o.nonce ?? randomBytes(16).toString("hex");
  const full = `/api/server/${path}`;
  const signature = sign({ secret: o.secret ?? SECRET, serverName: server, method, path: full, timestamp: now.getTime(), nonce, body: raw });
  const req = new Request(BASE + full, {
    method, body: method === "POST" ? raw : undefined,
    headers: { "content-type": "application/json", "x-ts-server": server, "x-ts-timestamp": String(now.getTime()), "x-ts-nonce": nonce, "x-ts-signature": signature },
  });
  const res = await handleServerApi(t.prisma, req, { secret: SECRET, now: () => now });
  const j = await res.json();
  return { status: res.status, ok: j.ok, data: j.data, error: j.error, headers: res.headers, requestId: j.requestId };
}

const hour = (n: number) => new Date(Date.UTC(2026, 10, 9, 12) - n * 3600_000);

describe("authentication of plugin requests", () => {
  it("rejects wrong secret, replay and unsigned requests without leaking details", async () => {
    const bad = await call("hello", { onlineMode: false }, { secret: randomBytes(32).toString("hex") });
    expect(bad).toMatchObject({ status: 401, ok: false, error: { code: "UNAUTHORIZED" } });
    const nonce = randomBytes(16).toString("hex");
    expect((await call("hello", { onlineMode: false }, { nonce })).status).toBe(200);
    expect((await call("hello", { onlineMode: false }, { nonce })).status).toBe(401);
    const unsigned = await handleServerApi(t.prisma, new Request(BASE + "/api/server/hello", { method: "POST", body: "{}" }), { secret: SECRET });
    expect(unsigned.status).toBe(401);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });

  it("returns a request id and sensible errors for bad routes, methods, bodies", async () => {
    const r = await call("hello", { onlineMode: true });
    expect(r.requestId).toBeTruthy();
    expect(r.headers.get("x-request-id")).toBe(r.requestId);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await call("nope", {})).status).toBe(404);
    expect((await call("__proto__", {})).status).toBe(404);
    expect((await call("hello", {}, { method: "GET" })).status).toBe(405);
    const notJson = await call("hello", null, { rawBody: "{not json" });
    expect(notJson).toMatchObject({ status: 400, error: { code: "VALIDATION" } });
    const invalid = await call("join", { mcUuid: randomUUID(), username: "bad name!" });
    expect(invalid).toMatchObject({ status: 400, error: { code: "VALIDATION" } });
    expect(invalid.error!.fields.username).toBeTruthy();
    const huge = await call("hello", null, { rawBody: JSON.stringify({ onlineMode: true, pad: "x".repeat(300_000) }) });
    expect(huge.status).toBe(413);
  });
});

describe("hello / join / playtime", () => {
  it("registers the server, adopts the plugin rate and reports the authoritative one", async () => {
    const r = await call("hello", { pluginVersion: "1.0.0", serverVersion: "Paper 26.3", onlineMode: true, secondsPerToken: 1800 }, { server: "survival" });
    expect(r.data).toMatchObject({ serverName: "survival", secondsPerToken: 1800 });
    const row = await t.prisma.serverInstance.findUniqueOrThrow({ where: { name: "survival" } });
    expect(row).toMatchObject({ pluginVersion: "1.0.0", onlineMode: true });
    await t.prisma.setting.deleteMany();
  });

  it("creates the Minecraft account on join and awards tokens for playtime once", async () => {
    const mcUuid = randomUUID();
    const join = await call("join", { mcUuid, username: "Alex_1" });
    expect(join.data).toMatchObject({ linked: false, balance: 0, playtimeTotalSeconds: 0 });

    const body = {
      mcUuid, username: "Alex_1", idempotencyKey: `pt-${randomUUID()}`,
      eligibleSeconds: 3600, afkSeconds: 0, periodStart: hour(1).toISOString(), periodEnd: hour(0).toISOString(),
    };
    const now = hour(0);
    const first = await call("playtime", body, { now });
    expect(first.data).toMatchObject({ replayed: false, tokensAwarded: 1, balance: 1, secondsPerToken: 3600 });
    const again = await call("playtime", body, { now });
    expect(again.data).toMatchObject({ replayed: true, tokensAwarded: 1, balance: 1 });
    const bal = await call("balance", { mcUuid });
    expect(bal.data).toMatchObject({ known: true, balance: 1, playtimeTotalSeconds: 3600 });
    const byName = await call("balance", { username: "alex_1" });
    expect(byName.data).toMatchObject({ known: true, balance: 1, username: "Alex_1", mcUuid });
    expect((await call("balance", { username: "NeverSeen_9" })).data).toMatchObject({ known: false, balance: 0 });
    expect((await call("balance", {})).status).toBe(400);
    expect((await call("balance", { mcUuid, username: "Alex_1" })).status).toBe(400);
  });

  it("rejects impossible playtime reports", async () => {
    const mcUuid = randomUUID();
    const r = await call("playtime", {
      mcUuid, username: "Alex_2", idempotencyKey: `pt-${randomUUID()}`, eligibleSeconds: 7200,
      periodStart: hour(1).toISOString(), periodEnd: hour(0).toISOString(),
    }, { now: hour(0) });
    expect(r).toMatchObject({ status: 400, error: { code: "VALIDATION" } });
  });

  it("lets the admin-set rate override the plugin's", async () => {
    await t.prisma.setting.createMany({ data: [{ key: "earning.seconds_per_token", value: "7200" }, { key: "earning.source", value: "admin" }] });
    const mcUuid = randomUUID();
    const r = await call("playtime", {
      mcUuid, username: "Alex_3", idempotencyKey: `pt-${randomUUID()}`, eligibleSeconds: 3600, secondsPerToken: 1800,
      periodStart: hour(1).toISOString(), periodEnd: hour(0).toISOString(),
    }, { now: hour(0) });
    expect(r.data).toMatchObject({ tokensAwarded: 0, secondsPerToken: 7200 });
    await t.prisma.setting.deleteMany();
  });
});

describe("leaderboard, history, shop", () => {
  it("ranks by balance and lists transactions newest first", async () => {
    const a = await makeAccount(t.prisma, { username: "TopA", balance: 50 });
    await makeAccount(t.prisma, { username: "TopB", balance: 80 });
    await makeAccount(t.prisma, { username: "TopZero", balance: 0 });
    const top = await call("top", { limit: 2 });
    expect(top.data.rows.map((r: any) => [r.rank, r.username, r.balance])).toEqual([[1, "TopB", 80], [2, "TopA", 50]]);

    await call("admin", { action: "give", target: { mcUuid: a.mcUuid }, amount: 5, idempotencyKey: `k-${randomUUID()}`, actorName: "Boss" });
    const h = await call("history", { mcUuid: a.mcUuid, limit: 5 });
    expect(h.data.rows[0]).toMatchObject({ amount: 5, type: "ADMIN_GIVE", balanceAfter: 55 });
    expect((await call("history", { mcUuid: randomUUID() })).data.rows).toEqual([]);
  });

  it("shows only purchasable products and never exposes commands", async () => {
    const cat = await makeCategory(t.prisma);
    const visible = await makeProduct(t.prisma, { categoryId: cat.id, price: 3, commands: ["secret-command {player}"] });
    await makeProduct(t.prisma, { categoryId: cat.id, enabled: false });
    await makeProduct(t.prisma, { categoryId: cat.id, stockLimit: 1 }).then((p) => t.prisma.product.update({ where: { id: p.id }, data: { stockSold: 1 } }));
    const shop = await call("shop", {});
    const mine = shop.data.categories.find((c: any) => c.id === cat.id);
    expect(mine.products.map((p: any) => p.id)).toEqual([visible.id]);
    expect(JSON.stringify(shop.data)).not.toContain("secret-command");
  });
});

describe("account linking via the API", () => {
  it("confirms /rconfirmT codes and enforces the online-mode rule for Premium", async () => {
    const input = regInput({ accountType: "PREMIUM" });
    const reg = await registerUser(t.prisma, input, { ip: ip() });
    const mcUuid = randomUUID();
    const offline = await call("confirm", { mcUuid, username: input.minecraftUsername, onlineMode: false, code: reg.linkCode });
    expect(offline).toMatchObject({ status: 403, error: { code: "FORBIDDEN" } });
    const ok = await call("confirm", { mcUuid, username: input.minecraftUsername, onlineMode: true, code: reg.linkCode });
    expect(ok.data).toMatchObject({ kind: "LINKED", accountType: "PREMIUM" });
    expect((await call("join", { mcUuid, username: input.minecraftUsername })).data.linked).toBe(true);
  });
});

describe("in-game purchases and reward delivery", () => {
  async function linkedBuyer(balance: number) {
    const input = regInput();
    const reg = await registerUser(t.prisma, input, { ip: ip() });
    const mcUuid = randomUUID();
    await call("confirm", { mcUuid, username: input.minecraftUsername, onlineMode: false, code: reg.linkCode });
    const acct = await t.prisma.minecraftAccount.findUniqueOrThrow({ where: { mcUuid } });
    await t.prisma.tokenBalance.upsert({ where: { mcAccountId: acct.id }, create: { mcAccountId: acct.id, balance }, update: { balance } });
    return { mcUuid, username: input.minecraftUsername, acct };
  }

  it("refuses unlinked players", async () => {
    const p = await makeProduct(t.prisma);
    const a = await makeAccount(t.prisma, { balance: 99 });
    const r = await call("purchase", { mcUuid: a.mcUuid, productId: p.id, idempotencyKey: `buy-${randomUUID()}` });
    expect(r).toMatchObject({ status: 403, error: { code: "ACCOUNT_NOT_LINKED" } });
    expect(await getBalance(t.prisma, a.id)).toBe(99);
  });

  it("buys, queues the reward, delivers it only to the online player, and confirms", async () => {
    const buyer = await linkedBuyer(20);
    const product = await makeProduct(t.prisma, { price: 8, commands: ["give {player} diamond 3"] });
    const key = `buy-${randomUUID()}`;
    const buy = await call("purchase", { mcUuid: buyer.mcUuid, productId: product.id, idempotencyKey: key });
    expect(buy.data).toMatchObject({ price: 8, balance: 12, replayed: false });
    expect((await call("purchase", { mcUuid: buyer.mcUuid, productId: product.id, idempotencyKey: key })).data).toMatchObject({ replayed: true, balance: 12 });

    const offline = await call("rewards/claim", { onlineUuids: [randomUUID()] });
    expect(offline.data.rewards).toEqual([]);
    const claim = await call("rewards/claim", { onlineUuids: [buyer.mcUuid] });
    expect(claim.data.rewards).toHaveLength(1);
    const reward = claim.data.rewards[0];
    expect(reward).toMatchObject({ mcUuid: buyer.mcUuid, username: buyer.username, commands: ["give {player} diamond 3"], commandsCompleted: 0 });

    const ack = await call("rewards/ack", { rewardId: reward.rewardId, outcome: "DELIVERED", commandsCompleted: 1 });
    expect(ack.data).toMatchObject({ replayed: false, status: "DELIVERED" });
    expect((await call("rewards/ack", { rewardId: reward.rewardId, outcome: "DELIVERED" })).data.replayed).toBe(true);
    expect((await call("rewards/claim", { onlineUuids: [buyer.mcUuid] })).data.rewards).toEqual([]);
    expect((await t.prisma.purchase.findUniqueOrThrow({ where: { id: buy.data.purchaseId } })).status).toBe("DELIVERED");
  });

  it("does not let another server acknowledge someone else's reward", async () => {
    const buyer = await linkedBuyer(10);
    const product = await makeProduct(t.prisma, { price: 1 });
    await call("purchase", { mcUuid: buyer.mcUuid, productId: product.id, idempotencyKey: `buy-${randomUUID()}` });
    const claim = await call("rewards/claim", { onlineUuids: [buyer.mcUuid] }, { server: "alpha" });
    const r = await call("rewards/ack", { rewardId: claim.data.rewards[0].rewardId, outcome: "DELIVERED" }, { server: "beta" });
    expect(r).toMatchObject({ status: 403, error: { code: "FORBIDDEN" } });
  });

  it("reports insufficient funds as a clean conflict", async () => {
    const buyer = await linkedBuyer(1);
    const product = await makeProduct(t.prisma, { price: 5 });
    const r = await call("purchase", { mcUuid: buyer.mcUuid, productId: product.id, idempotencyKey: `buy-${randomUUID()}` });
    expect(r).toMatchObject({ status: 409, error: { code: "INSUFFICIENT_FUNDS" } });
  });
});

describe("in-game admin commands", () => {
  it("gives, takes and sets tokens, with an audit entry each, and is repeat-safe", async () => {
    const a = await makeAccount(t.prisma, { username: "AdminTarget", balance: 10 });
    const k = `adm-${randomUUID()}`;
    const give = await call("admin", { action: "give", target: { username: "admintarget" }, amount: 5, idempotencyKey: k, actorName: "Owner" });
    expect(give.data).toMatchObject({ applied: true, balance: 15, delta: 5 });
    expect((await call("admin", { action: "give", target: { username: "admintarget" }, amount: 5, idempotencyKey: k, actorName: "Owner" })).data).toMatchObject({ applied: false, balance: 15 });
    expect((await call("admin", { action: "take", target: { mcUuid: a.mcUuid }, amount: 3, idempotencyKey: `adm-${randomUUID()}`, actorName: "Owner" })).data.balance).toBe(12);
    expect((await call("admin", { action: "set", target: { mcUuid: a.mcUuid }, amount: 100, idempotencyKey: `adm-${randomUUID()}`, actorName: "Owner" })).data).toMatchObject({ balance: 100, delta: 88 });
    expect(await getBalance(t.prisma, a.id)).toBe(100);

    const audits = await t.prisma.adminAuditLog.findMany({ where: { targetId: a.id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((x) => x.action)).toEqual(["tokens.give", "tokens.take", "tokens.set"]);
    expect(audits[0]).toMatchObject({ actorLabel: "in-game:Owner" });
  });

  it("validates targets and amounts", async () => {
    const base = { idempotencyKey: `adm-${randomUUID()}`, actorName: "Owner" };
    expect((await call("admin", { ...base, action: "give", target: { username: "NeverJoined" }, amount: 1 })).status).toBe(404);
    expect((await call("admin", { ...base, action: "give", target: {}, amount: 1 })).status).toBe(400);
    const a = await makeAccount(t.prisma, { balance: 2 });
    expect((await call("admin", { ...base, action: "give", target: { mcUuid: a.mcUuid }, amount: 0 })).status).toBe(400);
    expect((await call("admin", { ...base, action: "take", target: { mcUuid: a.mcUuid }, amount: 5 })).error!.code).toBe("INSUFFICIENT_FUNDS");
    expect(await getBalance(t.prisma, a.id)).toBe(2);
  });
});
