import type { Db, DbOrTx, Tx } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import type { TokenTransaction, TxType } from "../generated/prisma/client.ts";

/** Largest balance we allow (balances are stored as 32-bit integers). */
export const MAX_BALANCE = 2_000_000_000;
/** Largest single change we accept. */
export const MAX_CHANGE = 1_000_000_000;

export interface TokenChange {
  mcAccountId: string;
  /** Signed: positive credits, negative debits. */
  amount: number;
  type: TxType;
  /** Same key => same operation. A repeat returns the original result and changes nothing. */
  idempotencyKey: string;
  reason?: string;
  purchaseId?: string;
  actorUserId?: string;
  actorLabel?: string;
}

export interface TokenChangeResult {
  /** false when this call was a replay of an operation that already happened. */
  applied: boolean;
  transaction: TokenTransaction;
  balance: number;
}

export function assertWholeAmount(n: number, label = "Amount"): void {
  if (!Number.isSafeInteger(n)) throw new AppError("VALIDATION", `${label} must be a whole number`);
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length < 8 || key.length > 128) {
    throw new AppError("VALIDATION", "Idempotency key must be 8-128 characters");
  }
}

/**
 * Ensures the account has a balance row and locks it for the rest of the transaction.
 * Every balance-affecting operation on an account (tokens, playtime, purchases, refunds)
 * takes this lock first, so they run one at a time per account. That is what makes the
 * check-then-write idempotency and the insufficient-funds checks race-free.
 */
export async function lockBalance(tx: Tx, mcAccountId: string): Promise<number> {
  const account = await tx.minecraftAccount.findUnique({ where: { id: mcAccountId }, select: { id: true } });
  if (!account) throw new AppError("NOT_FOUND", "Minecraft account not found");
  await tx.$executeRaw`INSERT INTO token_balances (mc_account_id) VALUES (${mcAccountId}::uuid) ON CONFLICT (mc_account_id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ balance: number }[]>`SELECT balance FROM token_balances WHERE mc_account_id = ${mcAccountId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new AppError("INTERNAL", "Balance row missing after insert");
  return row.balance;
}

/** Applies a change. The caller MUST already hold the lock from lockBalance(). */
export async function applyLocked(tx: Tx, p: TokenChange, currentBalance: number): Promise<TokenChangeResult> {
  assertKey(p.idempotencyKey);
  assertWholeAmount(p.amount);
  if (Math.abs(p.amount) > MAX_CHANGE) throw new AppError("VALIDATION", "Amount is too large");

  const existing = await tx.tokenTransaction.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
  if (existing) {
    if (existing.mcAccountId !== p.mcAccountId || existing.type !== p.type || existing.amount !== p.amount) {
      throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different operation");
    }
    return { applied: false, transaction: existing, balance: currentBalance };
  }

  const next = currentBalance + p.amount;
  if (next < 0) {
    throw new AppError("INSUFFICIENT_FUNDS", `Not enough tokens (have ${currentBalance}, need ${-p.amount})`);
  }
  if (next > MAX_BALANCE) throw new AppError("VALIDATION", "Balance would exceed the maximum");

  await tx.$executeRaw`UPDATE token_balances SET balance = ${next}, updated_at = now() WHERE mc_account_id = ${p.mcAccountId}::uuid`;
  const transaction = await tx.tokenTransaction.create({
    data: {
      mcAccountId: p.mcAccountId,
      amount: p.amount,
      balanceAfter: next,
      type: p.type,
      reason: p.reason?.slice(0, 255) ?? null,
      idempotencyKey: p.idempotencyKey,
      purchaseId: p.purchaseId ?? null,
      actorUserId: p.actorUserId ?? null,
      actorLabel: p.actorLabel ?? null,
    },
  });
  return { applied: true, transaction, balance: next };
}

/** Credit or debit an account atomically. */
export async function changeTokens(db: Db, p: TokenChange): Promise<TokenChangeResult> {
  return db.$transaction(async (tx) => {
    const balance = await lockBalance(tx, p.mcAccountId);
    return applyLocked(tx, p, balance);
  });
}

/** Admin "set": records the difference as a single ADMIN_SET transaction. */
export async function setTokens(
  db: Db,
  p: {
    mcAccountId: string;
    target: number;
    idempotencyKey: string;
    reason?: string;
    actorUserId?: string;
    actorLabel?: string;
  },
): Promise<TokenChangeResult> {
  assertWholeAmount(p.target, "Balance");
  if (p.target < 0 || p.target > MAX_BALANCE) throw new AppError("VALIDATION", "Balance is out of range");
  return db.$transaction(async (tx) => {
    const balance = await lockBalance(tx, p.mcAccountId);
    const existing = await tx.tokenTransaction.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
    if (existing) {
      if (existing.mcAccountId !== p.mcAccountId || existing.type !== "ADMIN_SET") {
        throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different operation");
      }
      return { applied: false, transaction: existing, balance };
    }
    return applyLocked(
      tx,
      {
        mcAccountId: p.mcAccountId,
        amount: p.target - balance,
        type: "ADMIN_SET",
        idempotencyKey: p.idempotencyKey,
        reason: p.reason,
        actorUserId: p.actorUserId,
        actorLabel: p.actorLabel,
      },
      balance,
    );
  });
}

export async function getBalance(db: DbOrTx, mcAccountId: string): Promise<number> {
  const row = await db.tokenBalance.findUnique({ where: { mcAccountId } });
  return row?.balance ?? 0;
}

export async function listTransactions(
  db: DbOrTx,
  mcAccountId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<TokenTransaction[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return db.tokenTransaction.findMany({
    where: { mcAccountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    skip: opts.offset ?? 0,
  });
}
