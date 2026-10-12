"use client";

import { useActionState } from "react";

import { setCleanupScheduleAction, type ScheduleActionState } from "@/app/settings/storage/schedule-actions";
import { describeScheduleState, UNATTENDED_CLEANUP_AVAILABLE, type CleanupScheduleState } from "@/lib/cleanup-schedule";

const initial: ScheduleActionState = { error: null, success: null };
const TONE = { off: "bg-slate-50 text-slate-700", consent_only: "bg-amber-50 text-amber-900", active: "bg-emerald-50 text-emerald-900" } as const;

/** Consent switch for unattended cleanup. It is OFF by default and, today, backed by no runner: the text says exactly that. */
export function CleanupSchedulePanel({ state, canEdit, runnerAvailable = UNATTENDED_CLEANUP_AVAILABLE }: { state: CleanupScheduleState | null; canEdit: boolean; runnerAvailable?: boolean }) {
  const [result, action, pending] = useActionState(setCleanupScheduleAction, initial);
  if (!state) {
    return <section aria-labelledby="schedule-title" className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-xs text-slate-600"><h3 id="schedule-title" className="font-bold">Pembersihan otomatis</h3><p className="mt-1">Status persetujuan tidak ditampilkan (hanya pemilik bisnis, atau migrasi 20261031150000 belum diterapkan). Ini bukan tanda bahwa pembersihan otomatis mati.</p></section>;
  }
  const text = describeScheduleState(state, runnerAvailable);
  return (
    <section aria-labelledby="schedule-title" className="mt-4 rounded-2xl border bg-white p-5">
      <h3 id="schedule-title" className="font-bold">Pembersihan otomatis</h3>
      <p className={`mt-2 rounded-lg p-3 text-xs leading-5 ${TONE[text.tone]}`}><strong>{text.headline}.</strong> {text.detail}</p>
      {state.lastApplyAt ? <p className="mt-2 text-[11px] text-slate-500">Pembersihan terakhir: {new Date(state.lastApplyAt).toLocaleString("id-ID")} ({state.lastApplyStatus}).</p> : null}
      {canEdit ? (
        <form action={action} className="mt-3 flex flex-wrap items-end gap-3" aria-label="Persetujuan pembersihan otomatis">
          <label className="text-[11px] font-semibold text-slate-500">Jadwal
            <select name="cadence" defaultValue={state.cadence} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs"><option value="weekly">Mingguan</option><option value="monthly">Bulanan</option></select>
          </label>
          {state.enabled
            ? <button type="submit" name="enabled" value="false" disabled={pending} className="h-9 rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-bold text-rose-700 disabled:opacity-60">Matikan sekarang</button>
            : <button type="submit" name="enabled" value="true" disabled={pending} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 disabled:opacity-60">Catat persetujuan</button>}
        </form>
      ) : <p className="mt-2 text-[11px] text-slate-500">Hanya pemilik bisnis yang dapat mengubah persetujuan ini.</p>}
      <p aria-live="polite" className="mt-2 text-xs font-semibold">{result.error ? <span className="text-rose-700">{result.error}</span> : result.success ? <span className="text-emerald-700">{result.success}</span> : null}</p>
    </section>
  );
}
