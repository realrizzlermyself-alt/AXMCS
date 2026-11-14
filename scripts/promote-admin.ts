/**
 * Make a registered, linked player an administrator (the only way to create the first admin):
 *   npx tsx scripts/promote-admin.ts <minecraftUsername>
 */
import "dotenv/config";
import { createPrisma } from "../src/lib/db.ts";
import { writeAudit } from "../src/lib/audit.ts";

const name = process.argv[2]?.toLowerCase();
const url = process.env.DATABASE_URL;
if (!name || !url) {
  console.error("usage: DATABASE_URL=... npx tsx scripts/promote-admin.ts <minecraftUsername>");
  process.exit(1);
}
const prisma = createPrisma(url);
try {
  const user = await prisma.user.findUnique({ where: { minecraftUsernameLower: name } });
  if (!user) throw new Error(`No registered user "${name}"`);
  if (user.status !== "ACTIVE") throw new Error("That user has not linked their Minecraft account in-game yet");
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    await writeAudit(tx, { actorLabel: "cli", action: "user.promote_admin", targetType: "user", targetId: user.id });
  });
  console.log(`${user.minecraftUsername} is now an administrator.`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
