import type { Db } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import type { MinecraftAccount } from "../generated/prisma/client.ts";

const MC_USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidMcUsername(name: string): boolean {
  return MC_USERNAME.test(name);
}

export function normalizeUuid(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!UUID.test(v)) throw new AppError("VALIDATION", "Invalid Minecraft UUID");
  return v;
}

/**
 * Called when a player joins: records the UUID and keeps the latest username.
 * Players earn tokens before they ever register on the website, so the ledger belongs to
 * the Minecraft account, not to the website user.
 */
export async function ensureMinecraftAccount(
  db: Db,
  p: { mcUuid: string; username: string },
): Promise<MinecraftAccount> {
  if (!isValidMcUsername(p.username)) throw new AppError("VALIDATION", "Invalid Minecraft username");
  const mcUuid = normalizeUuid(p.mcUuid);
  return db.minecraftAccount.upsert({
    where: { mcUuid },
    create: { mcUuid, username: p.username },
    update: { username: p.username, lastSeenAt: new Date() },
  });
}
