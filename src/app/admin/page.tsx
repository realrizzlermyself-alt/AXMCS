import { notFound, redirect } from "next/navigation";
import { getPrisma } from "../../lib/db.ts";
import { csrfToken, currentAuth } from "../../web/session.ts";
import { getEarningConfig } from "../../services/settings.ts";
import { adminAdjustAction, adminRateAction } from "../actions.ts";
import { Notice } from "../Notice.tsx";

export default async function Admin({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const auth = await currentAuth();
  if (!auth) redirect("/login");
  if (auth.user.role !== "ADMIN" || auth.user.status !== "ACTIVE") notFound();
  const { e, ok } = await searchParams;
  const db = getPrisma();
  const csrf = await csrfToken();
  const [cfg, purchases, review, servers] = await Promise.all([
    getEarningConfig(db),
    db.purchase.findMany({ orderBy: { createdAt: "desc" }, take: 15, include: { account: { select: { username: true } } } }),
    db.rewardQueue.findMany({ where: { status: { in: ["NEEDS_REVIEW", "FAILED"] } }, orderBy: { updatedAt: "desc" }, take: 20, include: { purchase: { select: { productName: true } }, account: { select: { username: true } } } }),
    db.serverInstance.findMany({ orderBy: { lastSeenAt: "desc" }, take: 5 }),
  ]);
  const hidden = <input type="hidden" name="_csrf" value={csrf} />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Admin</h1>
      <Notice error={e} ok={ok} />
      <section className="card"><h2 className="mb-2 font-semibold">Connected servers</h2>
        {servers.length === 0 ? <p className="text-sm text-zinc-400">No server has contacted the site yet.</p> : servers.map((s) => <p key={s.id} className="text-sm">{s.name} <span className="text-zinc-500">last seen {s.lastSeenAt?.toISOString().slice(0, 16).replace("T", " ")}</span></p>)}</section>
      <section className="card"><h2 className="mb-2 font-semibold">Earning rate</h2>
        <p className="mb-3 text-sm text-zinc-400">Currently 1 token per {Math.round(cfg.secondsPerToken / 60)} minutes (source: {cfg.source}).</p>
        <form action={adminRateAction} className="flex gap-2">{hidden}<input name="minutes" type="number" min="1" step="1" defaultValue={Math.round(cfg.secondsPerToken / 60)} className="input max-w-32" /><button className="btn">Save</button></form></section>
      <section className="card"><h2 className="mb-2 font-semibold">Adjust a player&apos;s tokens</h2>
        <form action={adminAdjustAction} className="flex flex-wrap gap-2">{hidden}
          <input name="username" placeholder="Minecraft name" className="input max-w-48" required />
          <select name="action" className="input max-w-32"><option value="give">give</option><option value="take">take</option><option value="set">set</option></select>
          <input name="amount" type="number" min="0" placeholder="amount" className="input max-w-32" required /><button className="btn">Apply</button></form>
        <p className="mt-2 text-xs text-zinc-500">Every change is written to the audit log.</p></section>
      <section className="card"><h2 className="mb-2 font-semibold">Rewards needing attention</h2>
        {review.length === 0 ? <p className="text-sm text-zinc-400">None.</p> : review.map((r) => <p key={r.id} className="text-sm"><b>{r.account.username}</b> · {r.purchase.productName} · {r.status} <span className="text-zinc-500">{r.lastError ?? ""}</span></p>)}
        <p className="mt-2 text-xs text-zinc-500">NEEDS_REVIEW means the server may or may not have run the commands. Check in-game before re-giving anything.</p></section>
      <section className="card"><h2 className="mb-2 font-semibold">Recent purchases</h2>
        <table className="w-full text-sm"><tbody>{purchases.map((p) => <tr key={p.id} className="border-t border-zinc-800"><td className="py-1 text-zinc-400">{p.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{p.account.username}</td><td>{p.productName}</td><td>{p.unitPrice}</td><td className="text-right text-zinc-500">{p.status}</td></tr>)}</tbody></table></section>
    </div>
  );
}
