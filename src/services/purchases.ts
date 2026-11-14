import type { Db, Tx } from "../lib/db.ts";
import { isUniqueViolation } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import { applyLocked, lockBalance } from "./tokens.ts";
import type { Purchase, PurchaseSource, RewardQueue } from "../generated/prisma/client.ts";

export interface PurchaseRequest {
  mcAccountId: string;
  /** Website user who bought it, if any. */
  userId?: string;
  productId: string;
  source: PurchaseSource;
  /** Same key => same purchase. A repeated request returns the original and charges nothing. */
  idempotencyKey: string;
}

export interface PurchaseResult {
  purchase: Purchase;
  reward: RewardQueue | null;
  replayed: boolean;
  balance: number;
}

interface ClaimedProduct {
  id: string;
  name: string;
  price: number;
  commands: string[];
}

/**
 * Buys a product. Everything happens in ONE database transaction:
 *  lock account -> idempotency check -> per-player limit -> reserve stock (and read the price,
 *  atomically) -> create purchase -> debit tokens -> queue the reward.
 * If any step fails (e.g. not enough tokens) the whole thing rolls back, stock included.
 * Price, commands and availability always come from the database, never from the caller.
 */
export async function createPurchase(db: Db, req: PurchaseRequest): Promise<PurchaseResult> {
  if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.length < 8 || req.idempotencyKey.length > 128) {
    throw new AppError("VALIDATION", "Idempotency key must be 8-128 characters");
  }
  try {
    return await db.$transaction(async (tx) => {
      const balance = await lockBalance(tx, req.mcAccountId);

      const existing = await tx.purchase.findUnique({
        where: { idempotencyKey: req.idempotencyKey },
        include: { reward: true },
      });
      if (existing) {
        if (existing.mcAccountId !== req.mcAccountId || existing.productId !== req.productId) {
          throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different purchase");
        }
        return { purchase: existing, reward: existing.reward, replayed: true, balance };
      }

      const product = await reserveProduct(tx, req.productId);

      const limits = await tx.product.findUniqueOrThrow({
        where: { id: product.id },
        select: { perPlayerLimit: true },
      });
      if (limits.perPlayerLimit !== null) {
        const owned = await tx.purchase.count({
          where: { mcAccountId: req.mcAccountId, productId: product.id, status: { not: "CANCELLED" } },
        });
        if (owned >= limits.perPlayerLimit) {
          throw new AppError("LIMIT_REACHED", "You have reached the purchase limit for this product");
        }
      }

      const purchase = await tx.purchase.create({
        data: {
          mcAccountId: req.mcAccountId,
          userId: req.userId ?? null,
          productId: product.id,
          productName: product.name,
          unitPrice: product.price,
          source: req.source,
          idempotencyKey: req.idempotencyKey,
        },
      });

      const debit = await applyLocked(
        tx,
        {
          mcAccountId: req.mcAccountId,
          amount: 0 - product.price,
          type: "PURCHASE",
          idempotencyKey: `purchase:${purchase.id}`,
          reason: `Bought ${product.name}`,
          purchaseId: purchase.id,
          actorUserId: req.userId,
        },
        balance,
      );

      const reward = await tx.rewardQueue.create({
        data: { purchaseId: purchase.id, mcAccountId: req.mcAccountId, commands: product.commands },
      });
      return { purchase, reward, replayed: false, balance: debit.balance };
    });
  } catch (e) {
    // Same key used by a different account at the same moment.
    if (isUniqueViolation(e)) {
      throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different purchase");
    }
    throw e;
  }
}

/**
 * One statement checks availability, takes a stock slot and returns the product's current
 * price and commands. The UPDATE holds the product row lock until commit, so an admin
 * editing the price cannot slip in between "read price" and "charge price".
 */
async function reserveProduct(tx: Tx, productId: string): Promise<ClaimedProduct> {
  const rows = await tx.$queryRaw<ClaimedProduct[]>`
    UPDATE products p
       SET stock_sold = p.stock_sold + 1, updated_at = now()
     WHERE p.id = ${productId}::uuid
       AND p.deleted_at IS NULL
       AND p.enabled
       AND cardinality(p.commands) > 0
       AND EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.enabled)
       AND (p.stock_limit IS NULL OR p.stock_sold < p.stock_limit)
    RETURNING p.id, p.name, p.price, p.commands`;
  const row = rows[0];
  if (row) return row;

  // Work out why, for a useful message.
  const p = await tx.product.findUnique({
    where: { id: productId },
    select: { deletedAt: true, enabled: true, stockLimit: true, stockSold: true, commands: true, category: { select: { enabled: true } } },
  });
  if (!p || p.deletedAt || !p.enabled || !p.category.enabled || p.commands.length === 0) {
    throw new AppError("PRODUCT_UNAVAILABLE", "This product is not available");
  }
  throw new AppError("OUT_OF_STOCK", "This product is out of stock");
}

export interface CancelResult {
  /** false when the purchase had already been cancelled (safe repeat). */
  cancelled: boolean;
  refunded: number;
}

/**
 * Cancels a purchase whose reward has not been (or may not have been) delivered, refunds the
 * tokens exactly once and returns the stock slot. Refused while a delivery is in flight and
 * after successful delivery.
 */
export async function cancelPurchase(
  db: Db,
  p: { purchaseId: string; actorUserId?: string; actorLabel?: string; reason?: string; now?: Date },
): Promise<CancelResult> {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    const purchase = await tx.purchase.findUnique({ where: { id: p.purchaseId } });
    if (!purchase) throw new AppError("NOT_FOUND", "Purchase not found");

    const balance = await lockBalance(tx, purchase.mcAccountId);
    await tx.$queryRaw`SELECT id FROM reward_queue WHERE purchase_id = ${p.purchaseId}::uuid FOR UPDATE`;
    const fresh = await tx.purchase.findUniqueOrThrow({ where: { id: p.purchaseId }, include: { reward: true } });

    if (fresh.status === "CANCELLED") return { cancelled: false, refunded: 0 };
    if (fresh.status === "DELIVERED") {
      throw new AppError("INVALID_STATE", "This reward was already delivered and cannot be cancelled");
    }
    const reward = fresh.reward;
    if (reward) {
      const inFlight = reward.status === "CLAIMED" && reward.leaseExpiresAt !== null && reward.leaseExpiresAt > now;
      if (inFlight) throw new AppError("INVALID_STATE", "This reward is being delivered right now; try again shortly");
      if (reward.status === "DELIVERED") {
        throw new AppError("INVALID_STATE", "This reward was already delivered and cannot be cancelled");
      }
      await tx.rewardQueue.update({ where: { id: reward.id }, data: { status: "CANCELLED", leaseExpiresAt: null } });
    }
    await tx.purchase.update({
      where: { id: fresh.id },
      data: { status: "CANCELLED", cancelledAt: now, failureReason: p.reason?.slice(0, 255) ?? null },
    });
    const refund = await applyLocked(
      tx,
      {
        mcAccountId: fresh.mcAccountId,
        amount: fresh.unitPrice,
        type: "REFUND",
        idempotencyKey: `refund:${fresh.id}`,
        reason: `Refund: ${fresh.productName}`,
        purchaseId: fresh.id,
        actorUserId: p.actorUserId,
        actorLabel: p.actorLabel,
      },
      balance,
    );
    if (fresh.productId) {
      await tx.$executeRaw`UPDATE products SET stock_sold = GREATEST(stock_sold - 1, 0), updated_at = now() WHERE id = ${fresh.productId}::uuid`;
    }
    return { cancelled: true, refunded: refund.applied ? fresh.unitPrice : 0 };
  });
}
