"use client";

import { useActionState, useState } from "react";

import { setBranchCalendarHoursAction, type BusinessSettingsState } from "@/app/settings/business/actions";
import { DEFAULT_HOURS, formatMinutes, parseTime, TIME_OPTIONS, validateCalendarHours, type BranchHours } from "@/lib/business-settings";

const initial: BusinessSettingsState = { error: null, success: null };
const select = "mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs";

/** One branch's calendar hours. Reset sends the same typed RPC with no times, never a free-form settings write. */
export function BranchHoursForm({ branch, canEdit }: { branch: BranchHours; canEdit: boolean }) {
  const [state, action, pending] = useActionState(setBranchCalendarHoursAction, initial);
  const [open, setOpen] = useState(branch.effectiveStart);
  const [close, setClose] = useState(branch.effectiveEnd);
  const check = validateCalendarHours(open, close);
  return (
    <form action={action} className="rounded-xl border border-slate-200 bg-white p-4" aria-label={`Jam kalender ${branch.name}`}>
      <input type="hidden" name="branchId" value={branch.id} />
      <input type="hidden" name="updatedAt" value={branch.updatedAt} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[8rem]"><p className="text-sm font-bold text-slate-800">{branch.name}</p><p className="text-[11px] text-slate-500">{branch.storedStart === null ? `Bawaan ${formatMinutes(DEFAULT_HOURS.start)}–${formatMinutes(DEFAULT_HOURS.end)}` : "Diatur pemilik"}</p></div>
        <label className="text-[11px] font-semibold text-slate-500">Buka
          <select name="open" value={formatMinutes(open)} onChange={(event) => setOpen(parseTime(event.target.value) ?? open)} disabled={!canEdit || pending} className={select}>{TIME_OPTIONS.filter((m) => m <= 1320).map((m) => <option key={m} value={formatMinutes(m)}>{formatMinutes(m)}</option>)}</select>
        </label>
        <label className="text-[11px] font-semibold text-slate-500">Tutup
          <select name="close" value={formatMinutes(close)} onChange={(event) => setClose(parseTime(event.target.value) ?? close)} disabled={!canEdit || pending} className={select}>{TIME_OPTIONS.filter((m) => m >= 120).map((m) => <option key={m} value={formatMinutes(m)}>{formatMinutes(m)}</option>)}</select>
        </label>
        {canEdit ? <>
          <button type="submit" name="intent" value="save" disabled={pending || !check.ok} className="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan"}</button>
          <button type="submit" name="intent" value="reset" disabled={pending || branch.storedStart === null} className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-bold text-slate-600 disabled:opacity-50">Kembalikan ke bawaan</button>
        </> : <span className="text-[11px] text-slate-500">Hanya pemilik atau peran dengan branches.manage pada cabang ini yang dapat mengubah.</span>}
      </div>
      {!check.ok ? <p role="alert" className="mt-2 text-xs font-semibold text-rose-700">{check.message}</p> : null}
      <p aria-live="polite" className="mt-2 text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
    </form>
  );
}
