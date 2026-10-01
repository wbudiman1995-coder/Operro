"use client";

import { useState } from "react";
import type { SpeciesPricing } from "@/lib/pet-sizing";

export type PetTypeOption = { key: string; label: string; active: boolean };

export function SpeciesPricingFields({ petTypes, initial = {}, zeroTime }: { petTypes: PetTypeOption[]; initial?: SpeciesPricing; zeroTime: boolean }) {
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
  if (!custom.length) return <input type="hidden" name="speciesPricingJson" value="{}" />;
  return <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3"><input type="hidden" name="speciesPricingJson" value={JSON.stringify(payload)} /><p className="text-xs font-bold text-emerald-900">Jenis pet tambahan</p><p className="mt-1 text-[11px] text-slate-600">Isi harga dan durasi untuk jenis yang dilayani. Jika kosong, layanan ini tidak bisa dipilih untuk jenis tersebut.</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{custom.map((type) => <div key={type.key} className="rounded-lg bg-white p-3"><p className="text-xs font-bold">{type.label}</p><div className="mt-2 grid grid-cols-2 gap-2"><input type="number" min="0" step="1000" value={values[type.key]?.price ?? ""} onChange={(event) => change(type.key, "price", event.target.value)} placeholder="Harga Rp" aria-label={`Harga ${type.label}`} className="h-9 min-w-0 rounded-lg border px-2 text-xs" /><input type="number" min="0" max="1440" step="1" value={zeroTime ? "0" : values[type.key]?.duration ?? ""} onChange={(event) => change(type.key, "duration", event.target.value)} placeholder="Menit" aria-label={`Durasi ${type.label}`} disabled={zeroTime} className="h-9 min-w-0 rounded-lg border px-2 text-xs" /></div></div>)}</div></div>;
}
