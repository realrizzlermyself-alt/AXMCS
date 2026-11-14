import { redirect } from "next/navigation";
import Link from "next/link";
import { currentAuth } from "../../web/session.ts";
import { registerAction } from "../actions.ts";
import { Notice } from "../Notice.tsx";

export default async function Register({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await currentAuth()) redirect("/account");
  const { e } = await searchParams;
  return (
    <form action={registerAction} className="card mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-bold">Create your account</h1>
      <Notice error={e} />
      <div><label className="label" htmlFor="displayName">Display name</label><input id="displayName" name="displayName" className="input" required maxLength={32} /></div>
      <div><label className="label" htmlFor="minecraftUsername">Minecraft username</label><input id="minecraftUsername" name="minecraftUsername" className="input" required maxLength={16} autoComplete="username" /></div>
      <div><label className="label" htmlFor="accountType">Account type</label>
        <select id="accountType" name="accountType" className="input" defaultValue="OFFLINE"><option value="OFFLINE">Offline / cracked</option><option value="PREMIUM">Premium (Microsoft)</option></select></div>
      <div><label className="label" htmlFor="password">Password</label><input id="password" name="password" type="password" className="input" required autoComplete="new-password" /></div>
      <div><label className="label" htmlFor="confirmPassword">Repeat password</label><input id="confirmPassword" name="confirmPassword" type="password" className="input" required autoComplete="new-password" /></div>
      <p className="text-xs text-zinc-500">Never use your Minecraft or Microsoft password here. After registering you prove you own the name by typing a one-time code in-game.</p>
      <button className="btn w-full">Register</button>
      <p className="text-center text-sm">Already registered? <Link href="/login">Sign in</Link></p>
    </form>
  );
}
