import Link from "next/link";
import { getPrisma } from "../lib/db.ts";
import { leaderboard } from "../services/queries.ts";
import { getEarningConfig } from "../services/settings.ts";

export default async function Home() {
  const db = getPrisma();
  const [rows, cfg] = await Promise.all([leaderboard(db, 10).catch(() => []), getEarningConfig(db).catch(() => ({ secondsPerToken: 3600 }))]);
  const minutes = Math.round(cfg.secondsPerToken / 60);
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold">Play. Earn. Spend.</h1>
        <p className="mt-2 text-zinc-400">You earn 1 token for every {minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour(s)` : `${minutes} minutes`} you play on the server (AFK time does not count). Tokens have no real-money value.</p>
        <div className="mt-4 flex gap-3"><Link href="/register" className="btn">Create account</Link><Link href="/shop" className="btn-ghost">Browse the shop</Link></div>
      </section>
      <section className="card">
        <h2 className="mb-3 font-semibold">Top token holders</h2>
        {rows.length === 0 ? <p className="text-sm text-zinc-400">Nobody yet.</p> : (
          <ol className="space-y-1 text-sm">{rows.map((r) => <li key={r.rank} className="flex justify-between"><span>#{r.rank} {r.username}</span><span className="text-amber-400">{r.balance}</span></li>)}</ol>
        )}
      </section>
    </div>
  );
}
