"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function GoogleSignInButton({ next = "/organizations", label = "Lanjutkan dengan Google" }: { next?: string; label?: string }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function signIn() {
    setLoading(true); setError("");
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: oauthError } = await createClient().auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
    if (oauthError) { setError("Google Sign-In belum dapat dimulai. Pastikan Google sudah diaktifkan di pengaturan autentikasi Operro."); setLoading(false); }
  }

  return <div className="space-y-2"><button type="button" onClick={signIn} disabled={loading} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"><span aria-hidden="true" className="text-lg">G</span>{loading ? "Mengarahkan ke Google…" : label}</button>{error ? <p role="alert" className="text-xs font-semibold text-rose-700">{error}</p> : null}</div>;
}
