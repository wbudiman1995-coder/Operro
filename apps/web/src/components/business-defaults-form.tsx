"use client";

import { useActionState } from "react";

import { saveBusinessDefaultsAction, type BusinessSettingsState } from "@/app/settings/business/actions";
import { MAX_DUE_DAYS, MAX_LABEL_LENGTH, MAX_SOURCE_LABELS, type BusinessDefaults } from "@/lib/business-defaults";

const initial: BusinessSettingsState = { error: null, success: null };
const field = "mt-1 block w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs";

/** Two typed values: suggested source labels (one per line) and the default invoice due period. Never a free-form settings editor. */
export function BusinessDefaultsForm({ defaults, canEdit }: { defaults: BusinessDefaults; canEdit: boolean }) {
  const [state, action, pending] = useActionState(saveBusinessDefaultsAction, initial);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" aria-label="Bawaan bisnis">
      <input type="hidden" name="version" value={defaults.version} />
      <label className="text-[11px] font-semibold text-slate-500">Label sumber pelanggan (satu per baris, maksimal {MAX_SOURCE_LABELS})
        <textarea name="labels" rows={6} defaultValue={defaults.sourceLabels.join("\n")} disabled={!canEdit || pending} maxLength={MAX_SOURCE_LABELS * (MAX_LABEL_LENGTH + 2)} className={field} placeholder={"Instagram\nTeman\nGoogle"} />
        <span className="mt-1 block font-normal text-slate-500">Hanya saran di formulir pelanggan dan biaya pemasaran. Sumber tetap teks bebas: pelanggan lama dan nilai lain tidak ditolak.</span>
      </label>
      <label className="text-[11px] font-semibold text-slate-500">Jatuh tempo bawaan invoice baru (hari setelah tanggal invoice)
        <input name="dueDays" type="number" inputMode="numeric" min={0} max={MAX_DUE_DAYS} defaultValue={defaults.invoiceDueDays ?? ""} disabled={!canEdit || pending} className={`${field} h-9`} placeholder="Kosong = hari berikutnya" />
        <span className="mt-1 block font-normal text-slate-500">Hanya mengisi tanggal jatuh tempo pada invoice baru; tanggalnya tetap dapat diubah. Invoice yang sudah ada tidak berubah. Kosongkan untuk memakai bawaan Operro (hari berikutnya).</span>
      </label>
      <div className="sm:col-span-2">
        {canEdit
          ? <button type="submit" disabled={pending} className="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan bawaan"}</button>
          : <p className="text-[11px] text-slate-500">Hanya pemilik atau peran dengan settings.manage yang dapat mengubah bawaan.</p>}
        <p aria-live="polite" className="mt-2 text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
      </div>
    </form>
  );
}
