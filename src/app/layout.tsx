import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { currentAuth, csrfToken } from "../web/session.ts";
import { logoutAction } from "./actions.ts";

export const metadata: Metadata = { title: "TokenStore", description: "Earn tokens by playing. Spend them in the shop." };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const auth = await currentAuth().catch(() => null);
  const csrf = auth ? await csrfToken() : "";
  return (
    <html lang="en">
      <body>
        <header className="border-b border-zinc-800">
          <nav className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3 text-sm">
            <Link href="/" className="font-bold text-zinc-100">TokenStore</Link>
            <Link href="/shop">Shop</Link>
            <span className="flex-1" />
            {auth ? (
              <>
                {auth.user.role === "ADMIN" && <Link href="/admin">Admin</Link>}
                <Link href="/account">{auth.user.minecraftUsername}</Link>
                <form action={logoutAction}><input type="hidden" name="_csrf" value={csrf} /><button className="btn-ghost">Sign out</button></form>
              </>
            ) : (
              <><Link href="/login">Sign in</Link><Link href="/register" className="btn">Register</Link></>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
