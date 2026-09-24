"use client";

import { useActionState, useState } from "react";

import { updateServiceAction, type PilotActionState } from "@/app/pilot-actions";
import type { CatalogWorkspace } from "@/lib/pilot-data";
import { formatRupiah } from "@/lib/pilot-data";

const initialState: PilotActionState = { error: null, success: null };
const field = "h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";

function Message({ state }: { state: PilotActionState }) {
  return state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null;
}

const SIZE_FIELDS = [
  ["priceSmall", "small", "Kecil"],
  ["priceMedium", "medium", "Sedang"],
  ["priceLarge", "large", "Besar"],
  ["priceExtraLarge", "extraLarge", "Extra besar"],
] as const;

export function ServiceManager({ service, canManageService }: { service: CatalogWorkspace["services"][number]; canManageService: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(updateServiceAction, initialState);

  return <article className="p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-bold">{service.name}</p>
        <p className="mt-1 text-xs text-slate-500">{service.duration} menit{service.additionalDuration > 0 ? ` (+${service.additionalDuration} menit/unit tambahan)` : ""} · {formatRupiah(service.price)}</p>
        <p className="mt-1 text-[11px] text-slate-400">
          {SIZE_FIELDS.map(([key, , label]) => `${label}: ${service[key] === null ? "pakai harga dasar" : formatRupiah(service[key] as number)}`).join(" · ")}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${service.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{service.active ? "active" : "inactive"}</span>
        {canManageService ? <button type="button" onClick={() => setEditing((value) => !value)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700">{editing ? "Tutup" : "Edit"}</button> : null}
      </div>
    </div>
    {editing ? <form action={action} className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-4">
      <input type="hidden" name="serviceId" value={service.id} />
      <input className={field} name="name" defaultValue={service.name} required />
      <div className="grid gap-3 sm:grid-cols-2">
        <input className={field} type="number" min="15" step="15" name="duration" defaultValue={service.duration} aria-label="Durasi menit" required />
        <input className={field} type="number" min="0" step="5" name="additionalDuration" defaultValue={service.additionalDuration} aria-label="Durasi tambahan per unit" placeholder="Menit tambahan/unit" />
      </div>
      <input className={field} type="number" min="0" step="1000" name="price" defaultValue={service.price} placeholder="Harga dasar Rp" required />
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Harga per ukuran hewan (kosongkan untuk pakai harga dasar)</p>
        <div className="grid gap-3 sm:grid-cols-4">
          {SIZE_FIELDS.map(([key, suffix, label]) => <input key={suffix} className={field} type="number" min="0" step="1000" name={`price_${suffix}`} defaultValue={service[key] ?? ""} placeholder={label} aria-label={`Harga ${label}`} />)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-slate-700">
        {["home", "in_store"].map((mode) => <label key={mode} className="flex items-center gap-2"><input type="checkbox" name="fulfillmentModes" value={mode} defaultChecked={service.fulfillmentModes.includes(mode)} />{mode === "home" ? "Home service" : "Di toko"}</label>)}
        <label className="flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={service.active} />Aktif</label>
      </div>
      <Message state={state} />
      <button disabled={pending} className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan layanan"}</button>
    </form> : null}
  </article>;
}
