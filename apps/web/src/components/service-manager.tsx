"use client";

import { useActionState, useState } from "react";

import { updateServiceAction, type PilotActionState } from "@/app/pilot-actions";
import type { CatalogWorkspace } from "@/lib/pilot-data";
import { formatRupiah } from "@/lib/pilot-data";
import { SpeciesPricingFields, type PetTypeOption } from "@/components/species-pricing-fields";
import type { DogSizeBand } from "@/lib/pet-sizing";

const initialState: PilotActionState = { error: null, success: null };
const field = "h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";

function Message({ state }: { state: PilotActionState }) {
  return state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null;
}

const SIZE_FIELDS = [
  ["priceExtraSmall", "durationExtraSmall", "extraSmall", "XS"],
  ["priceSmall", "durationSmall", "small", "S"],
  ["priceMedium", "durationMedium", "medium", "M"],
  ["priceLarge", "durationLarge", "large", "L"],
  ["priceExtraLarge", "durationExtraLarge", "extraLarge", "XL"],
  ["priceCat", "durationCat", "cat", "Cat"],
] as const;

export function ServiceManager({ service, canManageService, petTypes, dogSizeBands }: { service: CatalogWorkspace["services"][number]; canManageService: boolean; petTypes: PetTypeOption[]; dogSizeBands: DogSizeBand[] }) {
  const [editing, setEditing] = useState(false);
  const [zeroTime, setZeroTime] = useState(service.duration === 0);
  const [duration, setDuration] = useState(String(service.duration || 60));
  const [state, action, pending] = useActionState(updateServiceAction, initialState);
  const activeSizeFields = SIZE_FIELDS.filter(([, , suffix]) => suffix === "cat" || dogSizeBands.some((band) => ({ extraSmall: "extra_small", small: "small", medium: "medium", large: "large", extraLarge: "extra_large" } as Record<string, string>)[suffix] === band.key));
  const labelFor = (suffix: string, fallback: string) => dogSizeBands.find((band) => band.key === ({ extraSmall: "extra_small", small: "small", medium: "medium", large: "large", extraLarge: "extra_large" } as Record<string, string>)[suffix])?.label ?? fallback;
  const customBands = dogSizeBands.filter((band) => !["extra_small", "small", "medium", "large", "extra_large"].includes(band.key));

  return <article className="p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-bold">{service.name}</p>
        <p className="mt-1 text-xs text-slate-500">{service.category ? `${service.category} · ` : ""}{service.duration === 0 ? "Tidak menambah durasi" : `${service.duration} menit`}{service.additionalDuration > 0 ? ` (+${service.additionalDuration} menit/unit tambahan)` : ""} · {formatRupiah(service.price)}</p>
        <p className="mt-1 text-[11px] text-slate-400">
          {[...activeSizeFields.map(([priceKey, durationKey, suffix, label]) => `${labelFor(suffix, label)}: ${service[priceKey] === null ? "harga dasar" : formatRupiah(service[priceKey] as number)}, ${service[durationKey] ?? service.duration} menit`), ...customBands.map((band) => `${band.label}: ${service.dogSizePricing[band.key]?.price == null ? "harga dasar" : formatRupiah(Number(service.dogSizePricing[band.key]?.price))}, ${service.dogSizePricing[band.key]?.duration ?? service.duration} menit`)].join(" · ")}
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
      <input className={field} name="category" list={`service-categories-${service.id}`} maxLength={40} defaultValue={service.category ?? ""} placeholder="Kategori layanan (boleh buat baru)" aria-label="Kategori layanan" />
      <datalist id={`service-categories-${service.id}`}><option value="Basic Grooming" /><option value="Styling" /><option value="Special Charges" /><option value="Other Fees" /><option value="Cat Grooming" /></datalist>
      <div className="grid gap-3 sm:grid-cols-2">
        <input className={field} type="number" min="15" step="5" name="duration" value={duration} onChange={(event) => setDuration(event.target.value)} disabled={zeroTime} aria-label="Durasi menit" required />
        <input className={field} type="number" min="0" step="5" name="additionalDuration" defaultValue={service.additionalDuration} disabled={zeroTime} aria-label="Durasi tambahan per unit" placeholder="Menit tambahan/unit" />
      </div>
      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700"><input type="checkbox" name="zeroTimeAddon" checked={zeroTime} onChange={(event) => setZeroTime(event.target.checked)} />Layanan tambahan berbayar, tanpa tambahan waktu booking</label>
      <input className={field} type="number" min="0" step="1000" name="price" defaultValue={service.price} placeholder="Harga dasar Rp" required />
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Harga per ukuran hewan (kosongkan untuk pakai harga dasar)</p>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {activeSizeFields.map(([priceKey, , suffix, label]) => { const currentLabel = labelFor(suffix, label); return <input key={suffix} className={field} type="number" min="0" step="1000" name={`price_${suffix}`} defaultValue={service[priceKey] ?? ""} placeholder={currentLabel} aria-label={`Harga ${currentLabel}`} />; })}
        </div>
      </div>
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Durasi per ukuran (kosong = durasi dasar)</p>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {activeSizeFields.map(([, durationKey, suffix, label]) => { const currentLabel = labelFor(suffix, label); return <input key={suffix} className={field} type="number" min="15" max="1440" step="5" name={`duration_${suffix}`} defaultValue={service[durationKey] ?? ""} placeholder={currentLabel} aria-label={`Durasi ${currentLabel}`} disabled={zeroTime} />; })}
        </div>
      </div>
      {customBands.map((band) => <div key={band.key} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-2"><label className="text-xs font-semibold">Harga {band.label} (Rp)<input className={field} type="number" min="0" step="1000" name={`price_band_${band.key}`} defaultValue={service.dogSizePricing[band.key]?.price ?? ""} /></label><label className="text-xs font-semibold">Durasi {band.label} (menit)<input className={field} type="number" min="15" max="1440" step="5" name={`duration_band_${band.key}`} defaultValue={service.dogSizePricing[band.key]?.duration ?? ""} disabled={zeroTime} /></label></div>)}
      <SpeciesPricingFields petTypes={petTypes} initial={service.speciesPricing} zeroTime={zeroTime} />
      <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-slate-700">
        {["home", "in_store"].map((mode) => <label key={mode} className="flex items-center gap-2"><input type="checkbox" name="fulfillmentModes" value={mode} defaultChecked={service.fulfillmentModes.includes(mode)} />{mode === "home" ? "Home service" : "Di toko"}</label>)}
        <label className="flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={service.active} />Aktif</label>
      </div>
      <Message state={state} />
      <button disabled={pending} className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan layanan"}</button>
    </form> : null}
  </article>;
}
