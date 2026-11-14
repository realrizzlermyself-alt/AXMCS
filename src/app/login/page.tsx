import { redirect } from "next/navigation";
import Link from "next/link";
import { currentAuth } from "../../web/session.ts";
import { loginAction } from "../actions.ts";
import { Notice } from "../Notice.tsx";

export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await currentAuth()) redirect("/account");
  const { e } = await searchParams;
  return (
    <form action={loginAction} className="card mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-bold">Sign in</h1>
      <Notice error={e} />
      <div><label className="label" htmlFor="username">Minecraft username</label><input id="username" name="username" className="input" required autoComplete="username" /></div>
      <div><label className="label" htmlFor="password">Password</label><input id="password" name="password" type="password" className="input" required autoComplete="current-password" /></div>
      <button className="btn w-full">Sign in</button>
      <p className="text-center text-sm">No account? <Link href="/register">Register</Link></p>
    </form>
  );
}
