"use client";

import { useActionState } from "react";

import { createBranchAction, type BranchActionState } from "@/app/settings/business/actions";

const initial: BranchActionState = { error: null, success: null };

export function BranchCreateForm({ canEdit }: { canEdit: boolean }) {
  const [state, action, pending] = useActionState(createBranchAction, initial);
  if (!canEdit) return null;
  return <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4"><summary className="cursor-pointer text-xs font-bold text-slate-800">+ Tambah cabang</summary>
    <form action={action} className="mt-3 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"><label className="text-xs font-semibold text-slate-700">Nama cabang<input name="name" required minLength={2} maxLength={100} placeholder="Contoh: Cabang Kemang" className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm" /></label><label className="text-xs font-semibold text-slate-700">Zona waktu<select name="timezone" defaultValue="Asia/Jakarta" className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="Asia/Jakarta">WIB · Asia/Jakarta</option><option value="Asia/Makassar">WITA · Asia/Makassar</option><option value="Asia/Jayapura">WIT · Asia/Jayapura</option></select></label><button disabled={pending} className="h-10 rounded-lg bg-emerald-700 px-4 text-xs font-bold text-white disabled:opacity-50">{pending ? "Membuat…" : "Buat cabang"}</button></form>
    {state.error || state.success ? <p role="status" className={`mt-3 text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-800"}`}>{state.error ?? state.success}</p> : null}
  </details>;
}
