"use client";

import { useActionState } from "react";

import { recordRecoveryDrillAction, type DrillState } from "@/app/settings/health/actions";

const initial: DrillState = { error: null, success: null };
const input = "mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs";

/** Platform owner only. Records that a restore drill was actually performed; it does not run or simulate one. */
export function RecoveryDrillForm() {
  const [state, action, pending] = useActionState(recordRecoveryDrillAction, initial);
  return <form action={action} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
    <h2 className="font-bold">Catat uji pemulihan (hanya pemilik platform)</h2>
    <p className="text-xs leading-5 text-slate-500">Catat uji yang benar-benar sudah dilakukan: memulihkan backup ke proyek percobaan lalu memverifikasi data. Catatan bersifat permanen. Jangan tulis kata sandi, token, atau connection string.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-[11px] font-semibold text-slate-500">Tanggal uji<input className={input} type="date" name="drillDate" required /></label>
      <label className="text-[11px] font-semibold text-slate-500">Hasil<select className={input} name="outcome" defaultValue="passed"><option value="passed">Lulus</option><option value="partial">Sebagian</option><option value="failed">Gagal</option></select></label>
      <label className="text-[11px] font-semibold text-slate-500">Dipulihkan ke<select className={input} name="restoredTo" defaultValue="disposable_project"><option value="disposable_project">Proyek percobaan sekali pakai</option><option value="staging_project">Proyek staging</option><option value="other">Lainnya</option></select></label>
      <label className="text-[11px] font-semibold text-slate-500">RPO terukur (menit)<input className={input} type="number" name="rpoMinutes" min={0} max={525600} /></label>
      <label className="text-[11px] font-semibold text-slate-500">RTO terukur (menit)<input className={input} type="number" name="rtoMinutes" min={0} max={525600} /></label>
    </div>
    <label className="block text-[11px] font-semibold text-slate-500">Catatan (maks. 500 karakter)<textarea className={`${input} h-20 py-2`} name="notes" maxLength={500} /></label>
    <label className="block text-[11px] font-semibold text-slate-500">Referensi bukti (nomor tiket/dokumen, maks. 300 karakter)<input className={input} name="evidenceRef" maxLength={300} /></label>
    <div className="flex items-center justify-between gap-2">
      <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
      <button type="submit" disabled={pending} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Catat uji"}</button>
    </div>
  </form>;
}
