import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { AppError, isAppError } from "../lib/errors.ts";
import { consume } from "../lib/rate-limit.ts";
import { parse } from "../lib/validation.ts";
import { verifyServerRequest } from "../lib/server-auth.ts";
import { ensureMinecraftAccount, normalizeUuid } from "../services/accounts.ts";
import { adminAdjustTokens } from "../services/admin-tokens.ts";
import { confirmInGame } from "../services/linking.ts";
import { recordPlaytime } from "../services/playtime.ts";
import { createPurchase } from "../services/purchases.ts";
import { catalog, findAccountByUsername, findAccountByUuid, history, leaderboard } from "../services/queries.ts";
import { ackReward, claimRewards } from "../services/rewards.ts";
import { getEarningConfig, resolveEarningRate } from "../services/settings.ts";
import { getBalance } from "../services/tokens.ts";

/**
 * Plugin <-> backend API. Every endpoint is `POST /api/server/<name>` with a JSON body and a
 * signed request (see lib/server-auth.ts). Framework independent: it takes a standard
 * Request and returns a standard Response, so the Next.js route is a one-liner:
 *
 *   export const POST = (req: Request) => handleServerApi(getPrisma(), req, { secret: process.env.TOKENSTORE_SERVER_SECRET! });
 */

export interface ServerApiOptions {
  secret: string;
  now?: () => Date;
  /** Receives one line per failure. Never contains secrets, signatures or request bodies. */
  log?: (line: string) => void;
}

const MAX_BODY_BYTES = 256 * 1024;
const PREFIX = "/api/server/";

const uuidStr = z.string().min(32).max(40);
const mcName = z.string().regex(/^[A-Za-z0-9_]{3,16}$/, "Invalid Minecraft username");
const idemKey = z.string().min(8).max(128);
const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date").transform((s) => new Date(s));
const seconds = z.number().int().min(0).max(10 * 24 * 3600);

const schemas = {
  hello: z.object({
    pluginVersion: z.string().max(32).optional(),
    serverVersion: z.string().max(64).optional(),
    onlineMode: z.boolean(),
    secondsPerToken: z.number().int().optional(),
  }),
  join: z.object({ mcUuid: uuidStr, username: mcName }),
  playtime: z.object({
    mcUuid: uuidStr, username: mcName, idempotencyKey: idemKey,
    eligibleSeconds: seconds, afkSeconds: seconds.default(0),
    periodStart: isoDate, periodEnd: isoDate,
    secondsPerToken: z.number().int().optional(),
  }),
  balance: z.object({ mcUuid: uuidStr.optional(), username: mcName.optional() })
    .refine((t) => Boolean(t.mcUuid) !== Boolean(t.username), "Give exactly one of mcUuid or username"),
  top: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  history: z.object({ mcUuid: uuidStr, limit: z.number().int().min(1).max(50).default(10) }),
  confirm: z.object({ mcUuid: uuidStr, username: mcName, onlineMode: z.boolean(), code: z.string().max(64) }),
  "rewards/claim": z.object({
    onlineUuids: z.array(uuidStr).max(2000), limit: z.number().int().min(1).max(50).optional(),
  }),
  "rewards/ack": z.object({
    rewardId: z.string().min(32).max(40),
    outcome: z.enum(["DELIVERED", "FAILED", "UNCERTAIN", "RELEASED"]),
    commandsCompleted: z.number().int().min(0).max(1000).optional(),
    error: z.string().max(500).optional(),
  }),
  shop: z.object({}),
  purchase: z.object({ mcUuid: uuidStr, productId: z.string().min(32).max(40), idempotencyKey: idemKey }),
  admin: z.object({
    action: z.enum(["give", "take", "set"]),
    target: z.object({ mcUuid: uuidStr.optional(), username: mcName.optional() })
      .refine((t) => Boolean(t.mcUuid) !== Boolean(t.username), "Give exactly one of mcUuid or username"),
    amount: z.number().int(),
    idempotencyKey: idemKey,
    actorName: z.string().min(1).max(32),
    actorUuid: uuidStr.optional(),
  }),
} as const;

type Route = keyof typeof schemas;
interface Ctx { db: Db; serverId: string; serverName: string; requestId: string; now: Date; ip: string | null }

const handlers: { [R in Route]: (c: Ctx, body: z.output<(typeof schemas)[R]>) => Promise<unknown> } = {
  async hello(c, b) {
    await c.db.serverInstance.update({
      where: { id: c.serverId },
      data: { pluginVersion: b.pluginVersion ?? null, serverVersion: b.serverVersion ?? null, onlineMode: b.onlineMode, lastError: null },
    });
    const rate = await resolveEarningRate(c.db, b.secondsPerToken);
    return { serverId: c.serverId, serverName: c.serverName, secondsPerToken: rate.secondsPerToken, serverTime: c.now.toISOString() };
  },

  async join(c, b) {
    const account = await ensureMinecraftAccount(c.db, b);
    const user = account.userId ? await c.db.user.findUnique({ where: { id: account.userId }, select: { status: true } }) : null;
    return {
      accountId: account.id,
      linked: user?.status === "ACTIVE",
      balance: await getBalance(c.db, account.id),
      playtimeTotalSeconds: account.playtimeTotalSeconds,
      playtimeCarrySeconds: account.playtimeCarrySeconds,
      secondsPerToken: (await getEarningConfig(c.db)).secondsPerToken,
    };
  },

  async playtime(c, b) {
    const account = await ensureMinecraftAccount(c.db, b);
    const rate = await resolveEarningRate(c.db, b.secondsPerToken);
    const r = await recordPlaytime(c.db, {
      mcAccountId: account.id, serverId: c.serverId, idempotencyKey: b.idempotencyKey,
      eligibleSeconds: b.eligibleSeconds, afkSeconds: b.afkSeconds,
      periodStart: b.periodStart, periodEnd: b.periodEnd, secondsPerToken: rate.secondsPerToken, now: c.now,
    });
    return { ...r, secondsPerToken: rate.secondsPerToken };
  },

  async balance(c, b) {
    const account = b.mcUuid
      ? await findAccountByUuid(c.db, normalizeUuid(b.mcUuid))
      : await findAccountByUsername(c.db, b.username!);
    if (!account) return { known: false, balance: 0, linked: false, playtimeTotalSeconds: 0, playtimeCarrySeconds: 0 };
    const user = account.userId ? await c.db.user.findUnique({ where: { id: account.userId }, select: { status: true } }) : null;
    return {
      known: true, username: account.username, mcUuid: account.mcUuid,
      balance: await getBalance(c.db, account.id), linked: user?.status === "ACTIVE",
      playtimeTotalSeconds: account.playtimeTotalSeconds, playtimeCarrySeconds: account.playtimeCarrySeconds,
    };
  },

  async top(c, b) { return { rows: await leaderboard(c.db, b.limit) }; },

  async history(c, b) {
    const account = await findAccountByUuid(c.db, normalizeUuid(b.mcUuid));
    return { rows: account ? await history(c.db, account.id, b.limit) : [] };
  },

  async confirm(c, b) {
    return confirmInGame(c.db, { mcUuid: b.mcUuid, username: b.username, onlineMode: b.onlineMode, code: b.code, now: c.now });
  },

  async "rewards/claim"(c, b) {
    const rewards = await claimRewards(c.db, { serverId: c.serverId, onlineMcUuids: b.onlineUuids, limit: b.limit, now: c.now });
    return { rewards };
  },

  async "rewards/ack"(c, b) {
    return ackReward(c.db, {
      rewardId: b.rewardId, serverId: c.serverId, outcome: b.outcome,
      commandsCompleted: b.commandsCompleted, error: b.error, now: c.now,
    });
  },

  async shop(c) { return { categories: await catalog(c.db) }; },

  async purchase(c, b) {
    const account = await findAccountByUuid(c.db, normalizeUuid(b.mcUuid));
    const user = account?.userId ? await c.db.user.findUnique({ where: { id: account.userId } }) : null;
    if (!account || !user || user.status !== "ACTIVE") {
      throw new AppError("ACCOUNT_NOT_LINKED", "Create a website account and link it with /rconfirmT before buying");
    }
    const r = await createPurchase(c.db, {
      mcAccountId: account.id, userId: user.id, productId: b.productId, source: "GAME", idempotencyKey: b.idempotencyKey,
    });
    return {
      purchaseId: r.purchase.id, productName: r.purchase.productName, price: r.purchase.unitPrice,
      balance: r.balance, replayed: r.replayed,
    };
  },

  async admin(c, b) {
    const account = b.target.mcUuid
      ? await findAccountByUuid(c.db, normalizeUuid(b.target.mcUuid))
      : await findAccountByUsername(c.db, b.target.username!);
    if (!account) throw new AppError("NOT_FOUND", "That player has never joined the server");
    const r = await adminAdjustTokens(c.db, {
      mcAccountId: account.id, action: b.action, amount: b.amount, idempotencyKey: b.idempotencyKey,
      actorLabel: `in-game:${b.actorName}`.slice(0, 64), requestId: c.requestId,
      reason: `${b.action} by ${b.actorName}`,
    });
    return { username: account.username, mcUuid: account.mcUuid, ...r };
  },
};

function json(status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId, ...extra },
  });
}

export async function handleServerApi(db: Db, req: Request, opts: ServerApiOptions): Promise<Response> {
  const requestId = (req.headers.get("x-request-id") ?? "").slice(0, 64).replace(/[^A-Za-z0-9_-]/g, "") || randomUUID();
  const now = opts.now?.() ?? new Date();
  const fail = (e: AppError) =>
    json(e.status, { ok: false, requestId, error: { code: e.code, message: e.message, fields: e.fields, retryAfterSeconds: e.retryAfterSeconds } },
      requestId, e.retryAfterSeconds ? { "retry-after": String(e.retryAfterSeconds) } : {});

  try {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(PREFIX)) throw new AppError("NOT_FOUND", "Unknown endpoint");
    const route = path.slice(PREFIX.length);
    if (!Object.hasOwn(schemas, route)) throw new AppError("NOT_FOUND", "Unknown endpoint");
    if (req.method !== "POST") {
      return json(405, { ok: false, requestId, error: { code: "VALIDATION", message: "Use POST" } }, requestId, { allow: "POST" });
    }

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { ok: false, requestId, error: { code: "VALIDATION", message: "Body too large" } }, requestId);
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { ok: false, requestId, error: { code: "VALIDATION", message: "Body too large" } }, requestId);

    const server = await verifyServerRequest(db, {
      secret: opts.secret, method: req.method, path, body: raw, now,
      headers: {
        serverName: req.headers.get("x-ts-server"), timestamp: req.headers.get("x-ts-timestamp"),
        nonce: req.headers.get("x-ts-nonce"), signature: req.headers.get("x-ts-signature"),
      },
    });
    await consume(db, `srv:${server.name}`, 1200, 60, now);

    let parsed: unknown;
    try { parsed = raw.length ? JSON.parse(raw) : {}; } catch { throw new AppError("VALIDATION", "Body is not valid JSON"); }
    const key = route as Route;
    const body = parse(schemas[key] as z.ZodType, parsed);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const data = await (handlers[key] as (c: Ctx, b: unknown) => Promise<unknown>)(
      { db, serverId: server.id, serverName: server.name, requestId, now, ip }, body);
    return json(200, { ok: true, requestId, data }, requestId);
  } catch (e) {
    if (isAppError(e)) {
      if (e.code === "UNAUTHORIZED") opts.log?.(`[${requestId}] rejected: ${e.message}`);
      return fail(e);
    }
    opts.log?.(`[${requestId}] internal error: ${(e as Error).message}`);
    return fail(new AppError("INTERNAL", "Internal error"));
  }
}
