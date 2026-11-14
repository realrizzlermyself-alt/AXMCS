import { redirect } from "next/navigation";
import Link from "next/link";
import { getPrisma } from "../../lib/db.ts";
import { currentAuth } from "../../web/session.ts";
import { getBalance } from "../../services/tokens.ts";
import { history } from "../../services/queries.ts";

export default async function Account() {
  const auth = await currentAuth();
  if (!auth) redirect("/login");
  if (auth.user.status !== "ACTIVE") redirect("/link");
  const db = getPrisma();
  const acct = await db.minecraftAccount.findUnique({ where: { userId: auth.user.id } });
  if (!acct) redirect("/link");
  const [balance, rows] = await Promise.all([getBalance(db, acct.id), history(db, acct.id, 25)]);
  const h = Math.floor(acct.playtimeTotalSeconds / 3600), m = Math.floor((acct.playtimeTotalSeconds % 3600) / 60);
  return (
    <div className="space-y-6">
      <section className="card flex items-end justify-between">
        <div><p className="label">Balance</p><p className="text-4xl font-bold text-amber-400">{balance}</p></div>
        <div className="text-right text-sm text-zinc-400">Playtime counted<br /><b className="text-zinc-100">{h}h {m}m</b></div>
      </section>
      <section className="card"><h2 className="mb-3 font-semibold">Recent activity</h2>
        {rows.length === 0 ? <p className="text-sm text-zinc-400">No transactions yet. <Link href="/shop">Visit the shop</Link> once you have tokens.</p> : (
          <table className="w-full text-sm"><tbody>{rows.map((r, i) => (
            <tr key={i} className="border-t border-zinc-800"><td className="py-1 text-zinc-400">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{r.type.toLowerCase().replace(/_/g, " ")}</td><td className={r.amount < 0 ? "text-red-400" : "text-emerald-400"}>{r.amount > 0 ? "+" : ""}{r.amount}</td><td className="text-right text-zinc-500">{r.balanceAfter}</td></tr>))}</tbody></table>
        )}
      </section>
    </div>
  );
}
