"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

/** Activates the code-only groomer session; no email address or password is collected. */
export function GroomerCodeAccess() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function activate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (normalized.length < 8) { setMessage("Masukkan kode groomer yang lengkap."); return; }
    setBusy(true); setMessage(null);
    const supabase = createClient();
    // The code is a single-use activation credential. A previous staff login on
    // this device must never inherit this groomer's schedule permissions.
    await supabase.auth.signOut({ scope: "local" });
    const anonymous = await supabase.auth.signInAnonymously();
    if (anonymous.error) {
      setMessage("Sesi groomer belum dapat dibuat. Minta administrator Operro mengaktifkan akses anonim Supabase, lalu coba lagi.");
      setBusy(false);
      return;
    }
    const claimed = await supabase.schema("app").rpc("claim_groomer_access_code", { p_code: normalized });
    if (claimed.error || typeof claimed.data !== "string") {
      await supabase.auth.signOut({ scope: "local" });
      setMessage("Kode tidak berlaku, sudah dipakai, atau sudah kedaluwarsa. Minta kode baru dari admin.");
      setBusy(false);
      return;
    }
    const selected = await supabase.rpc("set_active_organization", { p_organization_id: claimed.data });
    if (selected.error) {
      setMessage("Kode diterima, tetapi sesi belum siap. Muat ulang halaman ini sekali lalu coba lagi.");
      setBusy(false);
      return;
    }
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error) {
      setMessage("Sesi groomer belum dapat diperbarui. Coba lagi.");
      setBusy(false);
      return;
    }
    router.replace("/my-schedule");
    router.refresh();
  }

  return <form onSubmit={activate} className="mt-7 space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-950/5">
    <label className="block text-sm font-bold text-slate-800">Kode groomer
      <input value={code} onChange={(event) => setCode(event.target.value)} autoCapitalize="characters" autoComplete="one-time-code" placeholder="GRM-XXXXXXXXXXXX" className="mt-2 h-12 w-full rounded-xl border border-slate-300 px-3 font-mono text-base tracking-wider uppercase outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-500/15" />
    </label>
    <button disabled={busy} className="h-11 w-full rounded-xl bg-emerald-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Membuka jadwal…" : "Buka jadwal saya"}</button>
    {message ? <p role="alert" className="text-xs font-semibold text-rose-700">{message}</p> : null}
  </form>;
}
