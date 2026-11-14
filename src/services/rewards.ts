import { Prisma } from "../generated/prisma/client.ts";
import type { Db, DbOrTx } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import { normalizeUuid } from "./accounts.ts";

/**
 * Reward delivery protocol (plugin <-> backend)
 *
 *   PENDING --claim--> CLAIMED --ack DELIVERED--> DELIVERED
 *                         |----ack FAILED-------> FAILED        (admin may retry or cancel)
 *                         |----ack UNCERTAIN----> NEEDS_REVIEW  (admin decides)
 *                         |----ack RELEASED-----> PENDING        (plugin never started it)
 *                         `----lease expires----> NEEDS_REVIEW
 *
 * Delivery is AT MOST ONCE. A reward whose outcome is unknown is never silently re-queued;
 * it waits for an admin. The plugin keeps a local journal so it can tell "never started"
 * (safe to release) from "started but unknown" (must report UNCERTAIN).
 */

export const DEFAULT_LEASE_SECONDS = 15 * 60;
export const MAX_CLAIM_BATCH = 50;

export type AckOutcome = "DELIVERED" | "FAILED" | "UNCERTAIN" | "RELEASED";

export interface ClaimedReward {
  rewardId: string;
  purchaseId: string;
  mcUuid: string;
  username: string;
  productName: string;
  commands: string[];
  /** Commands already executed on earlier attempts; resume after this index. */
  commandsCompleted: number;
  attempts: number;
  leaseExpiresAt: Date;
}

/** Moves claims whose lease ran out without an acknowledgement to NEEDS_REVIEW. */
export async function reapExpiredClaims(db: DbOrTx, now: Date = new Date()): Promise<number> {
  return db.$executeRaw`
    WITH reaped AS (
      UPDATE reward_queue
         SET status = 'NEEDS_REVIEW',
             last_error = 'Delivery was not acknowledged before the lease expired',
             updated_at = now()
       WHERE status = 'CLAIMED' AND lease_expires_at < ${now}
       RETURNING purchase_id)
    UPDATE purchases SET status = 'NEEDS_REVIEW'
     WHERE id IN (SELECT purchase_id FROM reaped)`;
}

/**
 * Hands pending rewards for players who are online right now to a server.
 * Rewards for offline players stay queued until the player joins (the plugin passes only
 * online UUIDs). Rewards this same server already holds are returned again, so a lost HTTP
 * response never strands a reward; the plugin's journal prevents re-running them.
 */
export async function claimRewards(
  db: Db,
  p: {
    serverId: string;
    onlineMcUuids: string[];
    limit?: number;
    leaseSeconds?: number;
    now?: Date;
  },
): Promise<ClaimedReward[]> {
  const now = p.now ?? new Date();
  const limit = Math.min(Math.max(p.limit ?? 20, 1), MAX_CLAIM_BATCH);
  const leaseMs = (p.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
  const uuids = [...new Set(p.onlineMcUuids.map(normalizeUuid))].slice(0, 2000);

  return db.$transaction(async (tx) => {
    await reapExpiredClaims(tx, now);

    const held = await tx.rewardQueue.findMany({
      where: { status: "CLAIMED", claimedByServerId: p.serverId, leaseExpiresAt: { gt: now } },
      orderBy: { createdAt: "asc" },
      take: MAX_CLAIM_BATCH,
      select: { id: true },
    });

    let fresh: { id: string }[] = [];
    if (uuids.length > 0) {
      fresh = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT r.id
          FROM reward_queue r
          JOIN minecraft_accounts a ON a.id = r.mc_account_id
         WHERE r.status = 'PENDING'
           AND a.mc_uuid IN (${Prisma.join(uuids.map((u) => Prisma.sql`${u}::uuid`))})
         ORDER BY r.created_at ASC
         LIMIT ${limit}
         FOR UPDATE OF r SKIP LOCKED`);
      if (fresh.length > 0) {
        await tx.rewardQueue.updateMany({
          where: { id: { in: fresh.map((r) => r.id) }, status: "PENDING" },
          data: {
            status: "CLAIMED",
            claimedByServerId: p.serverId,
            claimedAt: now,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            attempts: { increment: 1 },
          },
        });
      }
    }

    const ids = [...held, ...fresh].map((r) => r.id);
    if (ids.length === 0) return [];
    const rows = await tx.rewardQueue.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: "asc" },
      include: { account: { select: { mcUuid: true, username: true } }, purchase: { select: { productName: true } } },
    });
    return rows.map((r) => ({
      rewardId: r.id,
      purchaseId: r.purchaseId,
      mcUuid: r.account.mcUuid,
      username: r.account.username,
      productName: r.purchase.productName,
      commands: r.commands,
      commandsCompleted: r.commandsCompleted,
      attempts: r.attempts,
      leaseExpiresAt: r.leaseExpiresAt ?? now,
    }));
  });
}

export interface AckResult {
  replayed: boolean;
  status: string;
  /** Set when the plugin's report arrives after an admin cancelled and refunded the purchase. */
  warning?: string;
}

/** The plugin reports what happened to a reward it claimed. Safe to repeat. */
export async function ackReward(
  db: Db,
  p: {
    rewardId: string;
    serverId: string;
    outcome: AckOutcome;
    commandsCompleted?: number;
    error?: string;
    now?: Date;
  },
): Promise<AckResult> {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM reward_queue WHERE id = ${p.rewardId}::uuid FOR UPDATE`;
    const reward = await tx.rewardQueue.findUnique({ where: { id: p.rewardId } });
    if (!reward) throw new AppError("NOT_FOUND", "Reward not found");

    // A repeated RELEASED report: the reward is already back in the queue.
    if (p.outcome === "RELEASED" && reward.status === "PENDING") return { replayed: true, status: "PENDING" };

    if (reward.claimedByServerId !== p.serverId) {
      throw new AppError("FORBIDDEN", "This reward was not claimed by this server");
    }

    const target =
      p.outcome === "DELIVERED" ? "DELIVERED"
      : p.outcome === "FAILED" ? "FAILED"
      : p.outcome === "UNCERTAIN" ? "NEEDS_REVIEW"
      : "PENDING";
    if (reward.status === target) return { replayed: true, status: reward.status };

    if (reward.status === "CANCELLED") {
      if (p.outcome === "DELIVERED") {
        const warning = "Delivered after the purchase was cancelled and refunded; review manually";
        await tx.rewardQueue.update({ where: { id: reward.id }, data: { lastError: warning } });
        return { replayed: false, status: "CANCELLED", warning };
      }
      throw new AppError("INVALID_STATE", "This reward was cancelled");
    }

    // Late truth is accepted for NEEDS_REVIEW (lease expired before the ack arrived).
    const canMove =
      reward.status === "CLAIMED" ||
      (reward.status === "NEEDS_REVIEW" && (p.outcome === "DELIVERED" || p.outcome === "FAILED"));
    if (!canMove) throw new AppError("INVALID_STATE", `Reward is ${reward.status} and cannot accept ${p.outcome}`);

    const total = reward.commands.length;
    const progress = p.commandsCompleted ?? reward.commandsCompleted;
    if (!Number.isInteger(progress) || progress < 0 || progress > total) {
      throw new AppError("VALIDATION", "commandsCompleted is out of range");
    }
    const error = p.error?.slice(0, 255) ?? null;

    switch (p.outcome) {
      case "DELIVERED":
        await tx.rewardQueue.update({
          where: { id: reward.id },
          data: { status: "DELIVERED", commandsCompleted: total, deliveredAt: now, leaseExpiresAt: null, lastError: null },
        });
        await tx.purchase.update({
          where: { id: reward.purchaseId },
          data: { status: "DELIVERED", deliveredAt: now, failureReason: null },
        });
        break;
      case "FAILED":
        await tx.rewardQueue.update({
          where: { id: reward.id },
          data: { status: "FAILED", commandsCompleted: progress, leaseExpiresAt: null, lastError: error },
        });
        await tx.purchase.update({
          where: { id: reward.purchaseId },
          data: { status: "FAILED", failureReason: error },
        });
        break;
      case "UNCERTAIN":
        await tx.rewardQueue.update({
          where: { id: reward.id },
          data: { status: "NEEDS_REVIEW", commandsCompleted: progress, leaseExpiresAt: null, lastError: error ?? "Delivery outcome is uncertain" },
        });
        await tx.purchase.update({ where: { id: reward.purchaseId }, data: { status: "NEEDS_REVIEW" } });
        break;
      case "RELEASED":
        await tx.rewardQueue.update({
          where: { id: reward.id },
          data: { status: "PENDING", commandsCompleted: progress, claimedByServerId: null, claimedAt: null, leaseExpiresAt: null },
        });
        break;
    }
    return { replayed: false, status: target };
  });
}

/** Admin: put a FAILED / NEEDS_REVIEW reward back in the queue. Resumes after commandsCompleted. */
export async function retryReward(
  db: Db,
  p: { purchaseId: string; now?: Date },
): Promise<{ status: string }> {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM reward_queue WHERE purchase_id = ${p.purchaseId}::uuid FOR UPDATE`;
    const reward = await tx.rewardQueue.findUnique({ where: { purchaseId: p.purchaseId } });
    if (!reward) throw new AppError("NOT_FOUND", "Reward not found");
    const expiredClaim = reward.status === "CLAIMED" && reward.leaseExpiresAt !== null && reward.leaseExpiresAt <= now;
    if (reward.status === "PENDING") return { status: "PENDING" };
    if (!(reward.status === "FAILED" || reward.status === "NEEDS_REVIEW" || expiredClaim)) {
      throw new AppError("INVALID_STATE", `Reward is ${reward.status} and cannot be retried`);
    }
    await tx.rewardQueue.update({
      where: { id: reward.id },
      data: { status: "PENDING", claimedByServerId: null, claimedAt: null, leaseExpiresAt: null, lastError: null },
    });
    await tx.purchase.update({ where: { id: reward.purchaseId }, data: { status: "PENDING_DELIVERY", failureReason: null } });
    return { status: "PENDING" };
  });
}
