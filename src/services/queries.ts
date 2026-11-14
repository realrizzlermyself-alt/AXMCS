import type { DbOrTx } from "../lib/db.ts";
import type { MinecraftAccount, TxType } from "../generated/prisma/client.ts";

export async function findAccountByUuid(db: DbOrTx, mcUuid: string): Promise<MinecraftAccount | null> {
  return db.minecraftAccount.findUnique({ where: { mcUuid } });
}

/** Most recently seen account with this username (names can be reused after a rename). */
export async function findAccountByUsername(db: DbOrTx, username: string): Promise<MinecraftAccount | null> {
  return db.minecraftAccount.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    orderBy: { lastSeenAt: "desc" },
  });
}

export interface LeaderboardRow { rank: number; username: string; balance: number }

export async function leaderboard(db: DbOrTx, limit: number): Promise<LeaderboardRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const rows = await db.$queryRaw<{ username: string; balance: number }[]>`
    SELECT a.username, b.balance
      FROM token_balances b
      JOIN minecraft_accounts a ON a.id = b.mc_account_id
     WHERE b.balance > 0
     ORDER BY b.balance DESC, a.username ASC
     LIMIT ${n}`;
  return rows.map((r, i) => ({ rank: i + 1, username: r.username, balance: r.balance }));
}

export interface HistoryRow { amount: number; balanceAfter: number; type: TxType; reason: string | null; createdAt: Date }

export async function history(db: DbOrTx, mcAccountId: string, limit: number): Promise<HistoryRow[]> {
  const rows = await db.tokenTransaction.findMany({
    where: { mcAccountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(Math.trunc(limit), 1), 50),
    select: { amount: true, balanceAfter: true, type: true, reason: true, createdAt: true },
  });
  return rows;
}

export interface CatalogProduct {
  id: string; name: string; description: string; price: number; type: string;
  iconMaterial: string; lore: string[]; imageUrl: string | null;
  /** null = unlimited */
  stockRemaining: number | null; perPlayerLimit: number | null;
}
export interface CatalogCategory {
  id: string; slug: string; name: string; description: string | null; iconMaterial: string; products: CatalogProduct[];
}

/**
 * What the shop shows. Contains NO commands: those never leave the backend except inside a
 * claimed reward, and only for a purchase that was actually paid for.
 */
export async function catalog(db: DbOrTx): Promise<CatalogCategory[]> {
  const categories = await db.category.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      products: {
        where: { enabled: true, deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      },
    },
  });
  return categories
    .map((c) => ({
      id: c.id, slug: c.slug, name: c.name, description: c.description, iconMaterial: c.iconMaterial,
      products: c.products
        .filter((p) => p.commands.length > 0 && (p.stockLimit === null || p.stockSold < p.stockLimit))
        .map((p) => ({
          id: p.id, name: p.name, description: p.description, price: p.price, type: p.type,
          iconMaterial: p.iconMaterial, lore: p.lore, imageUrl: p.imageUrl,
          stockRemaining: p.stockLimit === null ? null : p.stockLimit - p.stockSold,
          perPlayerLimit: p.perPlayerLimit,
        })),
    }))
    .filter((c) => c.products.length > 0);
}
