"use client";

import { useState } from "react";
import type { SpeciesPricing } from "@/lib/pet-sizing";

export type PetTypeOption = { key: string; label: string; active: boolean };

export function SpeciesPricingFields({ petTypes, initial = {}, zeroTime, formId }: { petTypes: PetTypeOption[]; initial?: SpeciesPricing; zeroTime: boolean; formId?: string }) {
  const [values, setValues] = useState<Record<string, { price: string; duration: string }>>(() => Object.fromEntries(
    Object.entries(initial).map(([key, value]) => [key, { price: String(value.price), duration: String(value.duration) }]),
  ));
  const custom = petTypes.filter((type) => type.active && !["dog", "cat"].includes(type.key));
  const payload = Object.fromEntries(custom.flatMap((type) => {
    const entry = values[type.key];
    if (!entry || (!entry.price && !entry.duration)) return [];
    return [[type.key, { price: entry.price ? Number(entry.price) : null, duration: zeroTime ? 0 : entry.duration ? Number(entry.duration) : null }]];
  }));
  const change = (key: string, field: "price" | "duration", value: string) => setValues((current) => ({ ...current, [key]: { price: current[key]?.price ?? "", duration: current[key]?.duration ?? "", [field]: value } }));
  if (!custom.length) return <input type="hidden" form={formId} name="speciesPricingJson" value="{}" />;
  return <section className="rounded-xl border border-slate-200 bg-white p-4"><input type="hidden" form={formId} name="speciesPricingJson" value={JSON.stringify(payload)} /><p className="text-sm font-bold text-slate-900">Jenis pet tambahan</p><p className="mt-1 text-xs text-slate-600">Isi harga dan durasi hanya untuk jenis yang dilayani. Jika kosong, layanan ini tidak dapat dipilih untuk jenis tersebut.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{custom.map((type) => <div key={type.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><p className="text-sm font-semibold text-slate-800">{type.label}</p><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-xs font-medium text-slate-600">Harga (Rp)<input form={formId} type="number" min="0" step="1000" value={values[type.key]?.price ?? ""} onChange={(event) => change(type.key, "price", event.target.value)} placeholder="—" aria-label={`Harga ${type.label}`} className="mt-1 h-9 min-w-0 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label><label className="text-xs font-medium text-slate-600">Menit<input form={formId} type="number" min="0" max="1440" step="1" value={zeroTime ? "0" : values[type.key]?.duration ?? ""} onChange={(event) => change(type.key, "duration", event.target.value)} placeholder="—" aria-label={`Durasi ${type.label}`} disabled={zeroTime} className="mt-1 h-9 min-w-0 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-100" /></label></div></div>)}</div></section>;
}
