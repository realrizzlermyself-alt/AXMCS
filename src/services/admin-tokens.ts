import type { Db } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { applyLocked, assertWholeAmount, lockBalance, MAX_BALANCE } from "./tokens.ts";

export type AdminTokenAction = "give" | "take" | "set";

export interface AdminAdjustment {
  mcAccountId: string;
  action: AdminTokenAction;
  /** give/take: a positive amount. set: the new balance. */
  amount: number;
  idempotencyKey: string;
  actorUserId?: string;
  /** e.g. "in-game:Notch" or "cli". */
  actorLabel?: string;
  reason?: string;
  ip?: string;
  requestId?: string;
}

/**
 * Admin give / take / set. The balance change, its transaction row and the audit-log entry
 * commit together or not at all. Repeating the same idempotencyKey changes nothing.
 */
export async function adminAdjustTokens(
  db: Db,
  p: AdminAdjustment,
): Promise<{ applied: boolean; balance: number; delta: number }> {
  assertWholeAmount(p.amount);
  if (p.action !== "set" && p.amount <= 0) throw new AppError("VALIDATION", "Amount must be at least 1");
  if (p.action === "set" && (p.amount < 0 || p.amount > MAX_BALANCE)) throw new AppError("VALIDATION", "Balance is out of range");

  return db.$transaction(async (tx) => {
    const current = await lockBalance(tx, p.mcAccountId);
    const delta = p.action === "give" ? p.amount : p.action === "take" ? -p.amount : p.amount - current;
    const type = p.action === "give" ? "ADMIN_GIVE" : p.action === "take" ? "ADMIN_TAKE" : "ADMIN_SET";

    const existing = await tx.tokenTransaction.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
    if (existing) {
      if (existing.mcAccountId !== p.mcAccountId || existing.type !== type) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different operation");
      }
      return { applied: false, balance: current, delta: existing.amount };
    }
    const res = await applyLocked(
      tx,
      {
        mcAccountId: p.mcAccountId, amount: delta, type, idempotencyKey: p.idempotencyKey,
        reason: p.reason, actorUserId: p.actorUserId, actorLabel: p.actorLabel,
      },
      current,
    );
    await writeAudit(tx, {
      actorUserId: p.actorUserId ?? null,
      actorLabel: p.actorLabel ?? null,
      action: `tokens.${p.action}`,
      targetType: "minecraft_account",
      targetId: p.mcAccountId,
      ip: p.ip ?? null,
      requestId: p.requestId ?? null,
      details: { amount: p.amount, delta, balanceBefore: current, balanceAfter: res.balance },
    });
    return { applied: res.applied, balance: res.balance, delta };
  });
}
