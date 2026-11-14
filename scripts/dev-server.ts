/**
 * Minimal HTTP server exposing the plugin API, for local development and end-to-end tests.
 * Production uses the Next.js route that calls the same handleServerApi().
 *   DATABASE_URL=... TOKENSTORE_SERVER_SECRET=... PORT=3100 npx tsx scripts/dev-server.ts
 */
import "dotenv/config";
import { createServer } from "node:http";
import { handleServerApi } from "../src/api/server-api.ts";
import { assertSecretStrength } from "../src/lib/server-auth.ts";
import { getPrisma } from "../src/lib/db.ts";

const secret = assertSecretStrength(process.env.TOKENSTORE_SERVER_SECRET);
const port = Number(process.env.PORT ?? 3100);
const db = getPrisma();

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(url, {
    method: req.method, headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const response = await handleServerApi(db, request, { secret, log: (l) => console.error(l) });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`TokenStore dev API listening on http://127.0.0.1:${port}`));
