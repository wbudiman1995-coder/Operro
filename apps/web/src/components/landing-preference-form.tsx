"use client";

import { useActionState } from "react";
import { saveLandingPageAction, type PreferenceState } from "@/app/settings/preferences/actions";
import { LANDING_PAGES } from "@/lib/preferences";

const initialState: PreferenceState = { error: null, success: null };

/** `available` lists the keys this person can currently open; `saved` may name one that is no longer available. */
export function LandingPreferenceForm({ saved, available }: { saved: string | null; available: string[] }) {
  const [state, action, pending] = useActionState(saveLandingPageAction, initialState);
  const stale = saved !== null && !available.includes(saved);
  return <form action={action} className="space-y-3">
    <label className="block text-xs font-semibold text-slate-600">Halaman awal setelah masuk
      <select name="landing" defaultValue={saved ?? ""} className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs">
        <option value="">Ringkasan (bawaan)</option>
        {LANDING_PAGES.filter((page) => page.key !== "dashboard").map((page) => <option key={page.key} value={page.key} disabled={!available.includes(page.key)}>{page.label}{available.includes(page.key) ? "" : " (tidak tersedia untuk peran Anda)"}</option>)}
      </select>
    </label>
    {stale ? <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">Pilihan tersimpan Anda tidak lagi tersedia untuk peran Anda di bisnis ini, sehingga Ringkasan dipakai. Pilihan tidak diubah.</p> : null}
    <p className="text-[11px] leading-5 text-slate-400">Preferensi ini milik akun Anda saja dan tidak mengubah pengaturan bisnis. Jika izin Anda berubah atau Anda membuka bisnis lain, Ringkasan dipakai.</p>
    <div className="flex items-center justify-between gap-2">
      <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
      <button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan"}</button>
    </div>
  </form>;
}
