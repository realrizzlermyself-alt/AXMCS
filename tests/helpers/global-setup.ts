import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * Builds one fully migrated template database for the whole test run. Each test file then
 * clones it (fast, isolated). Postgres comes from, in order:
 *   1. TEST_DATABASE_ADMIN_URL  - any Postgres you already run (a superuser URL, e.g.
 *      postgresql://postgres:pw@127.0.0.1:5432/postgres)
 *   2. an embedded PostgreSQL started just for the run (needs a non-root OS user).
 */
export default async function setup(): Promise<() => Promise<void>> {
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  let stopEmbedded: (() => Promise<void>) | undefined;

  if (!adminUrl) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = mkdtempSync(join(tmpdir(), "tokenstore-pg-"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      postgresFlags: ["-c", "fsync=off"],
    });
    await server.initialise();
    await server.start();
    adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    stopEmbedded = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const templateName = `ts_tpl_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${templateName}`);
  await admin.end();

  const tpl = new pg.Client({ connectionString: withDb(adminUrl, templateName) });
  await tpl.connect();
  const migrationsDir = join(process.cwd(), "prisma", "migrations");
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const d of dirs) {
    await tpl.query(readFileSync(join(migrationsDir, d, "migration.sql"), "utf8"));
  }
  await tpl.end();

  process.env.TEST_PG_ADMIN_URL = adminUrl;
  process.env.TEST_PG_TEMPLATE = templateName;

  return async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${templateName} WITH (FORCE)`);
    await a.end();
    await stopEmbedded?.();
  };
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
