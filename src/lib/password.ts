import { hash, verify } from "@node-rs/argon2";

/** Argon2id with the OWASP-recommended minimum parameters (19 MiB, 2 passes, 1 lane). */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** Verified against when a login names an unknown user, so response time doesn't reveal it. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("tokenstore-dummy-password-for-timing");
  return dummy;
}
