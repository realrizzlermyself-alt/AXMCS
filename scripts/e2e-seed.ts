// Seeds what the end-to-end run needs and prints it as JSON: a registered (not yet linked)
// player with a link code, and a purchasable product. Run from web/: npx tsx scripts/e2e-seed.ts
import { createPrisma } from "../src/lib/db.ts";
import { registerUser } from "../src/services/auth.ts";

const prisma = createPrisma(process.env.DATABASE_URL!);
const username = `E2E_${Math.random().toString(36).slice(2, 8)}`;
const reg = await registerUser(prisma, {
  displayName: "E2E Player", minecraftUsername: username, accountType: "OFFLINE",
  password: "e2e-test-passphrase", confirmPassword: "e2e-test-passphrase",
}, { ip: "10.0.0.1" });
const category = await prisma.category.create({ data: { slug: "e2e", name: "E2E" } });
const product = await prisma.product.create({
  data: { categoryId: category.id, slug: "e2e-diamond", name: "E2E Diamond", price: 1, type: "ITEM", commands: ["give {player} diamond 1"] },
});
console.log(JSON.stringify({ username, linkCode: reg.linkCode, productId: product.id }));
await prisma.$disconnect();
