import { randomInt } from "node:crypto";
import { sha256 } from "./sessions.ts";
import { AppError } from "../lib/errors.ts";

/** Every in-game code starts with this, e.g. ABXMCTSP-7K3Q-9XMD-2WPF. Players type /rconfirmT <code>. */
export const LINK_CODE_PREFIX = "ABXMCTSP";
export const LINK_CODE_LENGTH = 12;
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
/** No 0/1/I/O: easy to read aloud and to type. 32 symbols => 60 bits of randomness. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateLinkCode(): string {
  let body = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `${LINK_CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** Accepts what a person might type (lower case, spaces, missing dashes). Returns the canonical form. */
export function normalizeLinkCode(raw: string): string {
  const compact = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  const body = compact.startsWith(LINK_CODE_PREFIX) ? compact.slice(LINK_CODE_PREFIX.length) : null;
  if (body === null || body.length !== LINK_CODE_LENGTH || ![...body].every((c) => ALPHABET.includes(c))) {
    throw new AppError("VALIDATION", `That is not a valid code. Codes look like ${LINK_CODE_PREFIX}-XXXX-XXXX-XXXX`);
  }
  return `${LINK_CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

export function hashLinkCode(rawOrCanonical: string): string {
  return sha256(normalizeLinkCode(rawOrCanonical));
}
