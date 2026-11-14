/** Test helper: sends one signed plugin-API request. usage: tsx scripts/signed-call.ts <baseUrl> <secret> <route> '<json>' */
import { randomUUID } from "node:crypto";
import { sign } from "../src/lib/server-auth.ts";

const [base, secret, route, json = "{}"] = process.argv.slice(2);
const path = `/api/server/${route}`;
const ts = Date.now(), nonce = randomUUID();
const res = await fetch(base + path, {
  method: "POST",
  headers: {
    "content-type": "application/json", "x-ts-server": "webtest", "x-ts-timestamp": String(ts), "x-ts-nonce": nonce,
    "x-ts-signature": sign({ secret: secret!, serverName: "webtest", method: "POST", path, timestamp: ts, nonce, body: json }),
  },
  body: json,
});
console.log(await res.text());
