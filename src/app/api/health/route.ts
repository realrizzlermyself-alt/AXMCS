import { getPrisma } from "../../../lib/db.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Open https://YOUR-SITE/api/health to see what is missing. Reveals no secrets. */
export async function GET(): Promise<Response> {
  const checks = {
    databaseUrlSet: Boolean(process.env.DATABASE_URL),
    serverSecretSet: (process.env.TOKENSTORE_SERVER_SECRET ?? "").length >= 32,
    database: "unknown" as string,
  };
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "cannot connect (check DATABASE_URL and that migrations were run)";
  }
  const ok = checks.databaseUrlSet && checks.serverSecretSet && checks.database === "ok";
  return Response.json({ ok, ...checks }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
