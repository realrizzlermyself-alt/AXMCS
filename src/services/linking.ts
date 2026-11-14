import type { Db } from "../lib/db.ts";
import { AppError } from "../lib/errors.ts";
import { consume } from "../lib/rate-limit.ts";
import { hashLinkCode } from "./link-codes.ts";
import { normalizeUuid } from "./accounts.ts";
import { isValidMcUsername } from "./accounts.ts";

export type ConfirmOutcome =
  | { kind: "LINKED"; displayName: string; accountType: "PREMIUM" | "OFFLINE" }
  | { kind: "RESET_CONFIRMED"; displayName: string };

const INVALID = "That code is invalid or has expired";

/**
 * Handles `/rconfirmT <code>` typed by a player in-game. The plugin forwards the player's
 * identity from the server itself (UUID, name, whether the server authenticates players with
 * Mojang), so the website never has to trust anything the browser claims about Minecraft.
 *
 * LINK  : proves the website account owner is the player named at registration.
 *         PREMIUM accounts additionally require a Mojang-authenticated (online-mode) server.
 * RESET : proves the requester controls the account's own linked Minecraft UUID.
 */
export async function confirmInGame(
  db: Db,
  p: { mcUuid: string; username: string; onlineMode: boolean; code: string; now?: Date },
): Promise<ConfirmOutcome> {
  const now = p.now ?? new Date();
  const mcUuid = normalizeUuid(p.mcUuid);
  if (!isValidMcUsername(p.username)) throw new AppError("VALIDATION", "Invalid Minecraft username");
  let codeHash: string;
  try { codeHash = hashLinkCode(p.code); } catch (e) { await consume(db, `confirm:uuid:${mcUuid}`, 10, 600, now); throw e; }
  // Typing codes is rate limited per player so guessing is pointless.
  await consume(db, `confirm:uuid:${mcUuid}`, 10, 600, now);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM link_codes WHERE code_hash = ${codeHash} FOR UPDATE`;
    const row = await tx.linkCode.findUnique({ where: { codeHash }, include: { user: true } });
    if (!row || row.expiresAt <= now) throw new AppError("VALIDATION", INVALID);
    const user = row.user;
    if (user.status === "DISABLED") throw new AppError("VALIDATION", INVALID);

    if (row.purpose === "LINK") {
      if (row.consumedAt || user.status !== "PENDING_LINK") throw new AppError("VALIDATION", INVALID);
      if (user.minecraftUsernameLower !== p.username.toLowerCase()) {
        throw new AppError("FORBIDDEN", `This code was created for the username ${user.minecraftUsername}, not ${p.username}`);
      }
      if (user.accountType === "PREMIUM" && !p.onlineMode) {
        throw new AppError(
          "FORBIDDEN",
          "Premium accounts can only be verified on a server that authenticates players with Mojang (online-mode). Register as Offline, or use an online-mode server.",
        );
      }
      const account = await tx.minecraftAccount.upsert({
        where: { mcUuid },
        create: { mcUuid, username: p.username },
        update: { username: p.username, lastSeenAt: now },
      });
      if (account.userId && account.userId !== user.id) {
        throw new AppError("FORBIDDEN", "This Minecraft account is already linked to another website account");
      }
      await tx.minecraftAccount.update({
        where: { id: account.id },
        data: { userId: user.id, accountType: user.accountType, onlineModeVerified: p.onlineMode, linkedAt: now },
      });
      await tx.user.update({ where: { id: user.id }, data: { status: "ACTIVE", linkDeadline: null } });
      await tx.linkCode.deleteMany({ where: { userId: user.id, purpose: "LINK" } });
      return { kind: "LINKED", displayName: user.displayName, accountType: user.accountType };
    }

    // RESET: must be the very Minecraft account that is linked to this website account.
    const linked = await tx.minecraftAccount.findUnique({ where: { userId: user.id } });
    if (!linked || linked.mcUuid !== mcUuid) {
      throw new AppError("FORBIDDEN", "This reset was requested for a different Minecraft account");
    }
    if (!row.consumedAt) await tx.linkCode.update({ where: { id: row.id }, data: { consumedAt: now } });
    return { kind: "RESET_CONFIRMED", displayName: user.displayName };
  });
}
