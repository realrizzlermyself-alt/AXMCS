import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getPrisma } from "../../lib/db.ts";
import { csrfToken, currentAuth } from "../../web/session.ts";
import { catalog } from "../../services/queries.ts";
import { getBalance } from "../../services/tokens.ts";
import { buyAction } from "../actions.ts";
import { Notice } from "../Notice.tsx";

export default async function Shop({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { e, ok } = await searchParams;
  const db = getPrisma();
  const auth = await currentAuth();
  const categories = await catalog(db);
  let balance: number | null = null;
  if (auth?.user.status === "ACTIVE") {
    const acct = await db.minecraftAccount.findUnique({ where: { userId: auth.user.id } });
    if (acct) balance = await getBalance(db, acct.id);
  }
  const csrf = auth ? await csrfToken() : "";
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between"><h1 className="text-2xl font-bold">Shop</h1>{balance !== null && <p className="text-sm text-zinc-400">Your balance: <b className="text-amber-400">{balance}</b></p>}</div>
      <Notice error={e} ok={ok} />
      {!auth && <p className="text-sm text-zinc-400"><Link href="/login">Sign in</Link> or <Link href="/register">register</Link> to buy.</p>}
      {auth && balance === null && <p className="text-sm text-zinc-400">Link your Minecraft account first: <Link href="/link">link now</Link>.</p>}
      {categories.length === 0 && <p className="text-zinc-400">The shop is empty right now.</p>}
      {categories.map((c) => (
        <section key={c.id} className="space-y-3">
          <h2 className="font-semibold text-zinc-300">{c.name}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {c.products.map((p) => (
              <div key={p.id} className="card flex flex-col justify-between gap-3">
                <div><h3 className="font-semibold">{p.name}</h3><p className="text-sm text-zinc-400">{p.description}</p>
                  {p.stockRemaining !== null && <p className="mt-1 text-xs text-zinc-500">{p.stockRemaining} left</p>}</div>
                <div className="flex items-center justify-between"><span className="font-bold text-amber-400">{p.price} tokens</span>
                  {balance !== null && (
                    <form action={buyAction}><input type="hidden" name="_csrf" value={csrf} /><input type="hidden" name="productId" value={p.id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
                      <button className="btn" disabled={balance < p.price}>Buy</button></form>)}
                </div>
              </div>))}
          </div>
        </section>))}
    </div>
  );
}
