"use client";

import { useActionState } from "react";
import { saveEvidenceRetentionAction, type StorageActionState } from "@/app/settings/storage/actions";
import { EVIDENCE_RETENTION_MAX, EVIDENCE_RETENTION_MIN } from "@/lib/preferences";

const initialState: StorageActionState = { error: null, success: null };

/** Business-owned setting. Only the business owner can save; everyone else sees the value read-only. */
export function EvidenceRetentionForm({ days, canEdit }: { days: number; canEdit: boolean }) {
  const [state, action, pending] = useActionState(saveEvidenceRetentionAction, initialState);
  return <form action={action} className="space-y-2">
    <label className="block text-xs font-semibold text-slate-600">Masa simpan foto grooming (hari)
      <input name="days" type="number" inputMode="numeric" min={EVIDENCE_RETENTION_MIN} max={EVIDENCE_RETENTION_MAX} step={1} defaultValue={days} disabled={!canEdit} required
        className="mt-1 h-10 w-40 rounded-lg border border-slate-200 bg-white px-3 text-xs disabled:bg-slate-100 disabled:text-slate-400" />
    </label>
    <p className="text-[11px] leading-5 text-slate-400">Pengaturan bisnis: berlaku untuk semua anggota. Hanya foto yang diunggah setelah perubahan memakai nilai baru; foto yang sudah ada tidak berubah. {canEdit ? "" : "Hanya pemilik bisnis yang dapat mengubahnya."}</p>
    {canEdit ? <div className="flex items-center justify-between gap-2">
      <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
      <button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan"}</button>
    </div> : null}
  </form>;
}
