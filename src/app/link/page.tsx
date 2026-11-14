import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { csrfToken, currentAuth, FLASH_COOKIE } from "../../web/session.ts";
import { newCodeAction } from "../actions.ts";
import { AutoRefresh } from "../AutoRefresh.tsx";
import { Notice } from "../Notice.tsx";

export default async function LinkPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const auth = await currentAuth();
  if (!auth) redirect("/login");
  if (auth.user.status === "ACTIVE") redirect("/account");
  const { e } = await searchParams;
  const code = (await cookies()).get(FLASH_COOKIE)?.value;
  const csrf = await csrfToken();
  return (
    <div className="card mx-auto max-w-lg space-y-4">
      <AutoRefresh everyMs={5000} />
      <h1 className="text-xl font-bold">Link your Minecraft account</h1>
      <Notice error={e} />
      {code ? (
        <>
          <p className="text-sm text-zinc-300">Join the server as <b>{auth.user.minecraftUsername}</b> and type:</p>
          <pre className="select-all rounded-lg bg-zinc-950 p-3 text-center text-lg text-amber-400">/rconfirmT {code}</pre>
          <p className="text-xs text-zinc-500">The code works once and expires in 15 minutes. This page updates by itself when you are linked.</p>
        </>
      ) : <p className="text-sm text-zinc-300">Your code is not shown any more. Get a new one below.</p>}
      <form action={newCodeAction}><input type="hidden" name="_csrf" value={csrf} /><button className="btn-ghost">Get a new code</button></form>
    </div>
  );
}
