import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client.ts";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
/** Either the root client or an open transaction. */
export type DbOrTx = PrismaClient | Prisma.TransactionClient;

export function createPrisma(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as { __tokenstorePrisma?: PrismaClient };

/** Process-wide client (survives Next.js hot reloads in development). */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__tokenstorePrisma) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForPrisma.__tokenstorePrisma = createPrisma(url);
  }
  return globalForPrisma.__tokenstorePrisma;
}

/** True when a Prisma error is a unique-constraint violation. */
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
