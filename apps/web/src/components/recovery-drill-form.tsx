"use client";

import { useActionState, useState } from "react";

import { recordRecoveryDrillAction, type DrillState } from "@/app/settings/health/actions";
import { ARCHIVE_KINDS, DRILL_KIND_LABELS, DRILL_KINDS, type DrillKind } from "@/lib/recovery-evidence";

const initial: DrillState = { error: null, success: null };
const input = "mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs";
const label = "text-[11px] font-semibold text-slate-500";

/** Platform owner only. Records that a restore drill was actually performed; it does not run or simulate one. */
export function RecoveryDrillForm() {
  const [state, action, pending] = useActionState(recordRecoveryDrillAction, initial);
  const [kind, setKind] = useState<DrillKind>("provider_backup");
  const archive = ARCHIVE_KINDS.includes(kind);
  return <form action={action} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
    <h2 className="font-bold">Catat uji pemulihan (hanya pemilik platform)</h2>
    <p className="text-xs leading-5 text-slate-500">Catat uji yang benar-benar sudah dilakukan. Catatan bersifat permanen. Jangan tulis kata sandi, token, atau connection string. Untuk uji arsip, hash dari alat (manifes dan laporan) dicocokkan oleh database dengan export selesai; kecocokan hanya membuktikan arsipnya ada, bukan bahwa pemulihan terjadi, dan uji arsip tidak dapat dicatat sebagai lulus.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className={`${label} sm:col-span-3`}>Jenis uji
        <select className={input} name="kind" value={kind} onChange={(event) => setKind(event.target.value as DrillKind)}>{DRILL_KINDS.map((value) => <option key={value} value={value}>{DRILL_KIND_LABELS[value]}</option>)}</select>
      </label>
      <label className={label}>Tanggal uji<input className={input} type="date" name="drillDate" required /></label>
      <label className={label}>Hasil
        <select className={input} name="outcome" defaultValue={archive ? "partial" : "passed"} key={`outcome-${archive}`}>{archive ? null : <option value="passed">Lulus</option>}<option value="partial">Sebagian</option><option value="failed">Gagal</option></select>
      </label>
      <label className={label}>Dipulihkan ke<select className={input} name="restoredTo" defaultValue="disposable_project"><option value="disposable_project">Proyek percobaan sekali pakai</option><option value="staging_project">Proyek staging</option><option value="other">Lainnya</option></select></label>
      <label className={label}>RPO terukur (menit)<input className={input} type="number" name="rpoMinutes" min={0} max={525600} /></label>
      <label className={label}>RTO terukur (menit)<input className={input} type="number" name="rtoMinutes" min={0} max={525600} /></label>
    </div>
    {archive ? <div className="grid gap-3 sm:grid-cols-2">
      <label className={label}>Hash manifes arsip (64 hex huruf kecil)<input className={input} name="manifestSha" required pattern="[0-9a-f]{64}" maxLength={64} autoComplete="off" /></label>
      {kind === "guarded_archive_restore" ? <label className={label}>Hash laporan pemulihan (reportSha256)<input className={input} name="reportSha" required pattern="[0-9a-f]{64}" maxLength={64} autoComplete="off" /></label> : <input type="hidden" name="reportSha" value="" />}
    </div> : <><input type="hidden" name="manifestSha" value="" /><input type="hidden" name="reportSha" value="" /></>}
    <label className={`block ${label}`}>Catatan (maks. 500 karakter)<textarea className={`${input} h-20 py-2`} name="notes" maxLength={500} /></label>
    <label className={`block ${label}`}>Referensi bukti (nomor tiket/dokumen, maks. 300 karakter)<input className={input} name="evidenceRef" maxLength={300} /></label>
    <div className="flex items-center justify-between gap-2">
      <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
      <button type="submit" disabled={pending} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Catat uji"}</button>
    </div>
  </form>;
}
