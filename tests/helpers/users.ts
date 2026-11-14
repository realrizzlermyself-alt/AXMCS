import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../../src/lib/db.ts";
import { registerUser, type RegisterResult } from "../../src/services/auth.ts";
import { confirmInGame } from "../../src/services/linking.ts";

export const PASSWORD = "correct horse battery";
export const uname = (): string => `u${randomBytes(5).toString("hex")}`;
export const ip = (): string => `10.${randomInt()}.${randomInt()}.${randomInt()}`;
const randomInt = () => Math.floor(Math.random() * 250) + 1;

export function regInput(o: Record<string, unknown> = {}) {
  return {
    displayName: "Steve",
    minecraftUsername: uname(),
    accountType: "OFFLINE",
    password: PASSWORD,
    confirmPassword: PASSWORD,
    ...o,
  };
}

export interface LinkedUser extends RegisterResult {
  mcUuid: string;
  username: string;
}

/** Registers and links a user (offline-mode server, OFFLINE type unless overridden). */
export async function makeLinkedUser(
  db: Db,
  o: { accountType?: "OFFLINE" | "PREMIUM"; mcUuid?: string; onlineMode?: boolean } = {},
): Promise<LinkedUser> {
  const input = regInput({ accountType: o.accountType ?? "OFFLINE" });
  const reg = await registerUser(db, input, { ip: ip() });
  const mcUuid = o.mcUuid ?? randomUUID();
  await confirmInGame(db, {
    mcUuid,
    username: input.minecraftUsername,
    onlineMode: o.onlineMode ?? (o.accountType === "PREMIUM"),
    code: reg.linkCode,
  });
  return { ...reg, mcUuid, username: input.minecraftUsername };
}
