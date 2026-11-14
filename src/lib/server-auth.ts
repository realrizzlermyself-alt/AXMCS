import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import { isUniqueViolation } from "./db.ts";
import { AppError } from "./errors.ts";
import type { ServerInstance } from "../generated/prisma/client.ts";

/**
 * Authentication for the Paper plugin -> website API. Every request is signed:
 *
 *   signature = HMAC-SHA256(secret, SERVER \n METHOD \n PATH \n TIMESTAMP_MS \n NONCE \n SHA256(BODY))
 *
 * The secret itself is never sent. A signature is valid for 60 s and for a single use
 * (the nonce is recorded), so a captured request cannot be replayed.
 *
 * Headers: X-TS-Server, X-TS-Timestamp, X-TS-Nonce, X-TS-Signature.
 */

export const MAX_CLOCK_SKEW_MS = 60_000;
export const MIN_SECRET_LENGTH = 32;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export interface SignedHeaders {
  serverName?: string | null;
  timestamp?: string | null;
  nonce?: string | null;
  signature?: string | null;
}

export function bodyHash(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function sign(p: {
  secret: string; serverName: string; method: string; path: string; timestamp: number | string; nonce: string; body: string | Uint8Array;
}): string {
  // The server name is signed too, so a request cannot be re-labelled as coming from another server.
  const canonical = [p.serverName, p.method.toUpperCase(), p.path, String(p.timestamp), p.nonce, bodyHash(p.body)].join("\n");
  return createHmac("sha256", p.secret).update(canonical).digest("hex");
}

const deny = (why: string): never => {
  throw new AppError("UNAUTHORIZED", `Server authentication failed: ${why}`);
};

export function assertSecretStrength(secret: string | undefined): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`TOKENSTORE_SERVER_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

/** Verifies a signed plugin request and returns the (auto-registered) server it came from. */
export async function verifyServerRequest(
  db: Db,
  p: { secret: string; method: string; path: string; headers: SignedHeaders; body: string | Uint8Array; now?: Date },
): Promise<ServerInstance> {
  const now = p.now ?? new Date();
  const { serverName, timestamp, nonce, signature } = p.headers;
  if (!serverName || !timestamp || !nonce || !signature) return deny("missing headers");
  if (!SERVER_NAME.test(serverName)) return deny("bad server name");
  if (!NONCE.test(nonce)) return deny("bad nonce");
  if (!/^\d{10,16}$/.test(timestamp)) return deny("bad timestamp");
  if (Math.abs(now.getTime() - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return deny("timestamp outside allowed window");
  if (!/^[0-9a-f]{64}$/i.test(signature)) return deny("bad signature");

  const expected = Buffer.from(
    sign({ secret: p.secret, serverName, method: p.method, path: p.path, timestamp, nonce, body: p.body }),
    "hex",
  );
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return deny("invalid signature");

  // Only a correctly signed request may consume a nonce.
  const nonceHash = createHash("sha256").update(`${serverName}:${nonce}`).digest("hex");
  try {
    await db.serverNonce.create({
      data: { nonceHash, expiresAt: new Date(now.getTime() + 2 * MAX_CLOCK_SKEW_MS) },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return deny("request already used");
    throw e;
  }

  return db.serverInstance.upsert({
    where: { name: serverName },
    create: { name: serverName, lastSeenAt: now },
    update: { lastSeenAt: now },
  });
}

export async function purgeServerNonces(db: Db, now: Date = new Date()): Promise<number> {
  return (await db.serverNonce.deleteMany({ where: { expiresAt: { lt: now } } })).count;
}
