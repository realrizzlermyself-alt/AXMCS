import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import {
  assertSecretStrength, MAX_CLOCK_SKEW_MS, purgeServerNonces, sign, verifyServerRequest,
} from "../src/lib/server-auth.ts";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

const SECRET = randomBytes(32).toString("hex");
const NOW = new Date("2026-11-09T12:00:00Z");
const nonce = () => randomBytes(16).toString("hex");

function request(o: { secret?: string; method?: string; path?: string; body?: string; ts?: number; nonce?: string; server?: string } = {}) {
  const method = o.method ?? "POST";
  const path = o.path ?? "/api/server/rewards/claim";
  const body = o.body ?? '{"online":[]}';
  const timestamp = o.ts ?? NOW.getTime();
  const n = o.nonce ?? nonce();
  const server = o.server ?? "main";
  const signature = sign({ secret: o.secret ?? SECRET, serverName: server, method, path, timestamp, nonce: n, body });
  return {
    secret: SECRET, method, path, body, now: NOW,
    headers: { serverName: server, timestamp: String(timestamp), nonce: n, signature },
  };
}

describe("signed plugin requests", () => {
  it("accepts a valid signature and records the server", async () => {
    const s = await verifyServerRequest(t.prisma, request());
    expect(s.name).toBe("main");
    expect(s.lastSeenAt).not.toBeNull();
    const again = await verifyServerRequest(t.prisma, request());
    expect(again.id).toBe(s.id);
  });

  it("rejects a replayed request", async () => {
    const r = request();
    await verifyServerRequest(t.prisma, r);
    await expect(verifyServerRequest(t.prisma, r)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a tampered body, path, method, server name or nonce", async () => {
    const base = request();
    const variants = [
      { ...base, body: '{"online":["x"]}' },
      { ...base, path: "/api/server/rewards/ack" },
      { ...base, method: "GET" },
      { ...base, headers: { ...base.headers, serverName: "other" } },
      { ...base, headers: { ...base.headers, nonce: nonce() } },
    ];
    for (const v of variants) await expect(verifyServerRequest(t.prisma, v)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a wrong secret", async () => {
    await expect(verifyServerRequest(t.prisma, request({ secret: randomBytes(32).toString("hex") }))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects stale and future timestamps", async () => {
    await expect(verifyServerRequest(t.prisma, request({ ts: NOW.getTime() - MAX_CLOCK_SKEW_MS - 1000 }))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(verifyServerRequest(t.prisma, request({ ts: NOW.getTime() + MAX_CLOCK_SKEW_MS + 1000 }))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await verifyServerRequest(t.prisma, request({ ts: NOW.getTime() - 30_000 }));
  });

  it("rejects missing or malformed headers", async () => {
    const base = request();
    for (const h of [
      { ...base.headers, signature: undefined },
      { ...base.headers, nonce: "short" },
      { ...base.headers, timestamp: "abc" },
      { ...base.headers, serverName: "bad name!" },
      { ...base.headers, signature: "zz" },
      {},
    ]) {
      await expect(verifyServerRequest(t.prisma, { ...base, headers: h })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("does not let a forged request use up a legitimate nonce", async () => {
    const good = request();
    await expect(verifyServerRequest(t.prisma, { ...good, headers: { ...good.headers, signature: "0".repeat(64) } })).rejects.toBeDefined();
    await expect(verifyServerRequest(t.prisma, good)).resolves.toBeDefined();
  });

  it("accepts a nonce once even when sent concurrently", async () => {
    const r = request();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => verifyServerRequest(t.prisma, r)));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("purges expired nonces and insists on a strong secret", async () => {
    await verifyServerRequest(t.prisma, request());
    expect(await purgeServerNonces(t.prisma, new Date(NOW.getTime() + 10 * 60_000))).toBeGreaterThan(0);
    expect(() => assertSecretStrength("short")).toThrow();
    expect(() => assertSecretStrength(undefined)).toThrow();
    expect(assertSecretStrength(SECRET)).toBe(SECRET);
  });
});
