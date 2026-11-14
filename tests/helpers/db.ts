import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createPrisma, type Db } from "../../src/lib/db.ts";
import type { AccountType, ProductType } from "../../src/generated/prisma/client.ts";

export interface TestDb {
  prisma: Db;
  close(): Promise<void>;
}

/** A private, fully migrated database cloned from the run's template. */
export async function createTestDb(): Promise<TestDb> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL!;
  const template = process.env.TEST_PG_TEMPLATE!;
  const name = `ts_t_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const prisma = createPrisma(u.toString());

  return {
    prisma,
    async close() {
      await prisma.$disconnect();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

let counter = 0;

export async function makeAccount(
  db: Db,
  o: { username?: string; balance?: number; accountType?: AccountType } = {},
) {
  counter += 1;
  const account = await db.minecraftAccount.create({
    data: {
      mcUuid: randomUUID(),
      username: o.username ?? `Player${counter}x${randomBytes(2).toString("hex")}`.slice(0, 16),
      accountType: o.accountType,
    },
  });
  if (o.balance && o.balance > 0) {
    await db.tokenBalance.create({ data: { mcAccountId: account.id, balance: o.balance } });
  }
  return account;
}

export async function makeCategory(db: Db, o: { enabled?: boolean } = {}) {
  counter += 1;
  return db.category.create({
    data: { slug: `cat-${counter}-${randomBytes(3).toString("hex")}`, name: `Category ${counter}`, enabled: o.enabled ?? true },
  });
}

export async function makeProduct(
  db: Db,
  o: {
    categoryId?: string;
    price?: number;
    commands?: string[];
    enabled?: boolean;
    stockLimit?: number | null;
    perPlayerLimit?: number | null;
    type?: ProductType;
  } = {},
) {
  counter += 1;
  const categoryId = o.categoryId ?? (await makeCategory(db)).id;
  return db.product.create({
    data: {
      categoryId,
      slug: `prod-${counter}-${randomBytes(3).toString("hex")}`,
      name: `Product ${counter}`,
      price: o.price ?? 10,
      type: o.type ?? "COMMAND",
      commands: o.commands ?? ["give {player} diamond 1"],
      enabled: o.enabled ?? true,
      stockLimit: o.stockLimit ?? null,
      perPlayerLimit: o.perPlayerLimit ?? null,
    },
  });
}

export async function makeServer(db: Db, name = `srv-${randomBytes(3).toString("hex")}`) {
  return db.serverInstance.create({ data: { name } });
}

export const key = (label = "k"): string => `${label}-${randomUUID()}`;
