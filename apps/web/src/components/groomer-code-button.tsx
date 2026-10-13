"use client";

import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

export function GroomerCodeButton({ resourceId, name }: { resourceId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function createCode() {
    setBusy(true); setError(null);
    const response = await createClient().schema("app").rpc("issue_groomer_access_code", { p_resource: resourceId });
    if (response.error || typeof response.data !== "string") setError("Kode belum dapat dibuat. Pastikan groomer aktif dan Anda memiliki izin tim.");
    else setCode(response.data);
    setBusy(false);
  }
  return <div className="w-full rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 text-xs">
    <p className="font-bold text-emerald-950">Akses tanpa email</p><p className="mt-1 leading-5 text-emerald-900">Buat kode satu kali untuk {name}. Kode baru membatalkan kode yang belum dipakai sebelumnya.</p>
    {code ? <div className="mt-2 flex flex-wrap items-center gap-2"><code className="rounded bg-white px-2 py-1 font-bold tracking-wider text-slate-900">{code}</code><button type="button" onClick={() => navigator.clipboard.writeText(code)} className="rounded border border-emerald-300 bg-white px-2 py-1 font-bold text-emerald-800">Salin</button><a href="/groomer" target="_blank" rel="noreferrer" className="font-bold text-emerald-800 underline">Buka halaman groomer</a></div> : <button type="button" onClick={createCode} disabled={busy} className="mt-2 rounded-lg border border-emerald-300 bg-white px-3 py-2 font-bold text-emerald-800 disabled:opacity-50">{busy ? "Membuat…" : "Buat kode groomer"}</button>}
    {error ? <p role="alert" className="mt-2 font-semibold text-rose-700">{error}</p> : null}
  </div>;
}
