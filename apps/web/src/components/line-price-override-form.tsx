"use client";

import { useActionState, useState } from "react";

import { overrideGroomingLinePriceAction, type PilotActionState } from "@/app/pilot-actions";
import { formatRupiah } from "@/lib/pilot-data";

const initialState: PilotActionState = { error: null, success: null };
const field = "h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";

/** Lets an authorized staff member override a single resolved line price before the invoice is issued (section 21). */
export function LinePriceOverrideForm({ line }: { line: { id: string; name: string; unitPrice: number; priceSource: string } }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(overrideGroomingLinePriceAction, initialState);

  return <div className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs">
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate">{line.name} · {formatRupiah(line.unitPrice)}{line.priceSource === "manual_override" ? " (override)" : ""}</span>
      <button type="button" onClick={() => setOpen((value) => !value)} className="shrink-0 font-bold text-emerald-700">{open ? "Tutup" : "Ubah harga"}</button>
    </div>
    {open ? <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="lineId" value={line.id} />
      <div className="grid grid-cols-2 gap-2">
        <input className={field} type="number" min="0" step="1000" name="price" defaultValue={line.unitPrice} required aria-label="Harga baru" />
        <input className={field} name="reason" placeholder="Alasan override" required aria-label="Alasan override" />
      </div>
      {state.error || state.success ? <p className={`font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}
      <button disabled={pending} className="rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan harga"}</button>
    </form> : null}
  </div>;
}
