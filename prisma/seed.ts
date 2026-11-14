/**
 * Idempotent seed: safe to run any number of times. It never overwrites a product or
 * setting you have already edited; it only creates what is missing.
 *
 * Products that depend on third-party plugins (LuckPerms, a crates plugin) are seeded
 * DISABLED. Edit their commands for your server in the admin panel, then enable them.
 */
import "dotenv/config";
import { createPrisma } from "../src/lib/db.ts";
import { SETTING_KEYS, DEFAULT_SECONDS_PER_TOKEN } from "../src/services/settings.ts";
import type { ProductType } from "../src/generated/prisma/client.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const prisma = createPrisma(url);

const categories = [
  { slug: "items", name: "Items", description: "Useful items delivered straight to your inventory", iconMaterial: "CHEST", sortOrder: 10 },
  { slug: "keys", name: "Crate Keys", description: "Keys for the server crates", iconMaterial: "TRIPWIRE_HOOK", sortOrder: 20 },
  { slug: "ranks", name: "Ranks & Perks", description: "Ranks and permissions", iconMaterial: "NETHER_STAR", sortOrder: 30 },
  { slug: "cosmetics", name: "Cosmetics", description: "Show off with something special", iconMaterial: "FIREWORK_ROCKET", sortOrder: 40 },
];

interface SeedProduct {
  slug: string; category: string; name: string; description: string; price: number;
  type: ProductType; iconMaterial: string; lore: string[]; commands: string[]; enabled: boolean; sortOrder: number;
}

const products: SeedProduct[] = [
  {
    slug: "diamond-pack", category: "items", name: "Diamond Pack", description: "5 diamonds, delivered instantly.",
    price: 5, type: "ITEM", iconMaterial: "DIAMOND", lore: ["&7Five shiny diamonds."], commands: ["give {player} diamond 5"], enabled: true, sortOrder: 10,
  },
  {
    slug: "golden-apples", category: "items", name: "Golden Apples x8", description: "Eight golden apples for tough fights.",
    price: 3, type: "ITEM", iconMaterial: "GOLDEN_APPLE", lore: ["&7Eat up."], commands: ["give {player} golden_apple 8"], enabled: true, sortOrder: 20,
  },
  {
    slug: "common-crate-key", category: "keys", name: "Common Crate Key", description: "One key for the common crate. (Example: needs a crates plugin.)",
    price: 4, type: "CRATE_KEY", iconMaterial: "TRIPWIRE_HOOK", lore: ["&7Opens the common crate."], commands: ["crate givekey {player} common 1"], enabled: false, sortOrder: 10,
  },
  {
    slug: "vip-rank", category: "ranks", name: "VIP Rank", description: "Adds you to the VIP group. (Example: needs LuckPerms.)",
    price: 100, type: "RANK", iconMaterial: "NETHER_STAR", lore: ["&6Permanent VIP rank."], commands: ["lp user {player} parent add vip"], enabled: false, sortOrder: 10,
  },
  {
    slug: "firework-trail", category: "cosmetics", name: "Firework Celebration", description: "Launches a celebratory announcement. (Example command.)",
    price: 2, type: "COSMETIC", iconMaterial: "FIREWORK_ROCKET", lore: ["&7Celebrate in style."], commands: ["say {player} is celebrating!"], enabled: false, sortOrder: 10,
  },
];

async function main() {
  const settings: [string, string][] = [
    [SETTING_KEYS.secondsPerToken, String(DEFAULT_SECONDS_PER_TOKEN)],
    [SETTING_KEYS.earningSource, "plugin"],
  ];
  for (const [key, value] of settings) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: {} });
  }

  const categoryIds = new Map<string, string>();
  for (const c of categories) {
    const row = await prisma.category.upsert({ where: { slug: c.slug }, create: c, update: {} });
    categoryIds.set(c.slug, row.id);
  }

  for (const p of products) {
    const { category, ...data } = p;
    await prisma.product.upsert({
      where: { slug: p.slug },
      create: { ...data, categoryId: categoryIds.get(category)! },
      update: {},
    });
  }
  console.log(`Seeded ${categories.length} categories, ${products.length} products, ${settings.length} settings.`);
}

main().finally(() => prisma.$disconnect());
