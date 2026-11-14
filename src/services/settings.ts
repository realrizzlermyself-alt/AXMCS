import type { DbOrTx } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";

export const DEFAULT_SECONDS_PER_TOKEN = 3600;
/** Bounds for the earning rate: 1 minute .. 7 days per token. */
export const MIN_SECONDS_PER_TOKEN = 60;
export const MAX_SECONDS_PER_TOKEN = 7 * 24 * 3600;

export type EarningSource = "plugin" | "admin";

export const SETTING_KEYS = {
  secondsPerToken: "earning.seconds_per_token",
  earningSource: "earning.source",
} as const;

export function validateRate(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < MIN_SECONDS_PER_TOKEN || seconds > MAX_SECONDS_PER_TOKEN) {
    throw new AppError(
      "VALIDATION",
      `Seconds per token must be a whole number between ${MIN_SECONDS_PER_TOKEN} and ${MAX_SECONDS_PER_TOKEN}`,
    );
  }
  return seconds;
}

export async function getSetting(db: DbOrTx, key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(db: DbOrTx, key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function getEarningConfig(
  db: DbOrTx,
): Promise<{ secondsPerToken: number; source: EarningSource }> {
  const [rate, source] = await Promise.all([
    getSetting(db, SETTING_KEYS.secondsPerToken),
    getSetting(db, SETTING_KEYS.earningSource),
  ]);
  const parsed = rate === null ? NaN : Number(rate);
  return {
    secondsPerToken: Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SECONDS_PER_TOKEN,
    source: source === "admin" ? "admin" : "plugin",
  };
}

/** Admin panel: set the rate and make the admin value authoritative. */
export async function setEarningFromAdmin(
  db: DbOrTx,
  p: { secondsPerToken: number; source: EarningSource },
): Promise<void> {
  validateRate(p.secondsPerToken);
  await setSetting(db, SETTING_KEYS.secondsPerToken, String(p.secondsPerToken));
  await setSetting(db, SETTING_KEYS.earningSource, p.source);
}

/**
 * Decides which rate applies to a playtime submission.
 * - source "admin": the stored value always wins.
 * - source "plugin": the rate reported by the plugin's config.yml is adopted
 *   (and stored, so the admin panel shows it) when it is valid.
 */
export async function resolveEarningRate(
  db: DbOrTx,
  reportedSeconds?: number,
): Promise<{ secondsPerToken: number; changed: boolean }> {
  const cfg = await getEarningConfig(db);
  if (cfg.source === "plugin" && reportedSeconds !== undefined) {
    validateRate(reportedSeconds);
    if (reportedSeconds !== cfg.secondsPerToken) {
      await setSetting(db, SETTING_KEYS.secondsPerToken, String(reportedSeconds));
      return { secondsPerToken: reportedSeconds, changed: true };
    }
  }
  return { secondsPerToken: cfg.secondsPerToken, changed: false };
}
