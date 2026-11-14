import type { Db } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import { applyLocked, assertWholeAmount, lockBalance } from "./tokens.ts";
import { MAX_SECONDS_PER_TOKEN, MIN_SECONDS_PER_TOKEN } from "./settings.ts";

/** A single submission may cover at most this much wall-clock time (covers long API outages). */
export const MAX_PERIOD_SECONDS = 24 * 3600;
/** Submissions may not end later than this far in the future (clock skew tolerance). */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface PlaytimeSubmission {
  mcAccountId: string;
  serverId?: string;
  /** Unique per submission; a retry with the same key never awards twice. */
  idempotencyKey: string;
  /** Seconds that count toward tokens (online and not AFK). */
  eligibleSeconds: number;
  afkSeconds?: number;
  periodStart: Date;
  periodEnd: Date;
  secondsPerToken: number;
  now?: Date;
}

export interface PlaytimeResult {
  replayed: boolean;
  tokensAwarded: number;
  balance: number;
  /** Eligible seconds that have not yet added up to a whole token. */
  carrySeconds: number;
  totalSeconds: number;
}

/**
 * Records a block of eligible playtime and awards whole tokens.
 * Leftover seconds are carried over, so nothing is lost between submissions.
 */
export async function recordPlaytime(db: Db, p: PlaytimeSubmission): Promise<PlaytimeResult> {
  const now = p.now ?? new Date();
  const afk = p.afkSeconds ?? 0;
  assertWholeAmount(p.eligibleSeconds, "Eligible seconds");
  assertWholeAmount(afk, "AFK seconds");
  assertWholeAmount(p.secondsPerToken, "Seconds per token");
  if (p.eligibleSeconds < 0 || afk < 0) throw new AppError("VALIDATION", "Seconds cannot be negative");
  if (p.secondsPerToken < MIN_SECONDS_PER_TOKEN || p.secondsPerToken > MAX_SECONDS_PER_TOKEN) {
    throw new AppError("VALIDATION", "Seconds per token is out of range");
  }
  if (!(p.periodStart instanceof Date) || Number.isNaN(p.periodStart.getTime()) ||
      !(p.periodEnd instanceof Date) || Number.isNaN(p.periodEnd.getTime())) {
    throw new AppError("VALIDATION", "Invalid period");
  }
  const spanSeconds = Math.floor((p.periodEnd.getTime() - p.periodStart.getTime()) / 1000);
  if (spanSeconds < 0) throw new AppError("VALIDATION", "Period ends before it starts");
  if (spanSeconds > MAX_PERIOD_SECONDS) throw new AppError("VALIDATION", "Period is too long");
  if (p.periodEnd.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new AppError("VALIDATION", "Period is in the future");
  }
  // Eligible time can never exceed the wall-clock time the period covers.
  if (p.eligibleSeconds + afk > spanSeconds + 1) {
    throw new AppError("VALIDATION", "Reported playtime exceeds the period length");
  }

  return db.$transaction(async (tx) => {
    const balance = await lockBalance(tx, p.mcAccountId);
    const account = await tx.minecraftAccount.findUniqueOrThrow({
      where: { id: p.mcAccountId },
      select: { playtimeCarrySeconds: true, playtimeTotalSeconds: true },
    });

    const existing = await tx.playtimeRecord.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
    if (existing) {
      if (existing.mcAccountId !== p.mcAccountId) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a different account");
      }
      return {
        replayed: true,
        tokensAwarded: existing.tokensAwarded,
        balance,
        carrySeconds: account.playtimeCarrySeconds,
        totalSeconds: account.playtimeTotalSeconds,
      };
    }

    // The same stretch of time must never be counted twice under two different keys.
    if (p.periodEnd.getTime() > p.periodStart.getTime()) {
      const overlap = await tx.playtimeRecord.findFirst({
        where: {
          mcAccountId: p.mcAccountId,
          periodStart: { lt: p.periodEnd },
          periodEnd: { gt: p.periodStart },
        },
        select: { id: true },
      });
      if (overlap) throw new AppError("OVERLAPPING_PERIOD", "This period overlaps playtime that was already recorded");
    }

    const accumulated = account.playtimeCarrySeconds + p.eligibleSeconds;
    const tokens = Math.floor(accumulated / p.secondsPerToken);
    const carry = accumulated - tokens * p.secondsPerToken;
    const total = account.playtimeTotalSeconds + p.eligibleSeconds;

    await tx.minecraftAccount.update({
      where: { id: p.mcAccountId },
      data: { playtimeTotalSeconds: total, playtimeCarrySeconds: carry, lastSeenAt: now },
    });
    await tx.playtimeRecord.create({
      data: {
        mcAccountId: p.mcAccountId,
        serverId: p.serverId ?? null,
        idempotencyKey: p.idempotencyKey,
        eligibleSeconds: p.eligibleSeconds,
        afkSeconds: afk,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        rateSeconds: p.secondsPerToken,
        tokensAwarded: tokens,
      },
    });

    let newBalance = balance;
    if (tokens > 0) {
      const res = await applyLocked(
        tx,
        {
          mcAccountId: p.mcAccountId,
          amount: tokens,
          type: "PLAYTIME",
          idempotencyKey: `playtime:${p.idempotencyKey}`,
          reason: `${Math.round(p.eligibleSeconds / 60)} min of playtime`,
          actorLabel: p.serverId ? `server:${p.serverId}` : "server",
        },
        balance,
      );
      newBalance = res.balance;
    }
    return { replayed: false, tokensAwarded: tokens, balance: newBalance, carrySeconds: carry, totalSeconds: total };
  });
}
