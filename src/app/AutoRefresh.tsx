"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => { const t = setInterval(() => router.refresh(), everyMs); return () => clearInterval(t); }, [router, everyMs]);
  return null;
}
