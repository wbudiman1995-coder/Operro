"use client";

import { useActionState, useState, type ChangeEvent } from "react";
import { editCustomerPetAction, type CustomerPetEditState } from "@/app/customers/[customerId]/actions";
import { BreedSelect } from "@/components/breed-select";

const initialState: CustomerPetEditState = { error: null, success: null };
const inputClass = "mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 disabled:bg-slate-100 disabled:text-slate-400";
const labelClass = "text-[11px] font-semibold text-slate-500";

export interface CustomerPetDefaults {
  name: string;
  species: string;
  breed: string;
  sex: "male" | "female" | "unknown";
  birthdate: string;
  weightKg: string;
  manualSize: string;
  color: string;
  temperament: string;
  notes: string;
}

interface Option { key: string; label: string; disabled?: boolean }

export function CustomerPetEditor({
  customerId,
  petId,
  updatedAt,
  currentSizeLabel,
  defaults,
  petTypes,
  dogBands,
}: {
  customerId: string;
  petId: string;
  updatedAt: string;
  currentSizeLabel: string | null;
  defaults: CustomerPetDefaults;
  petTypes: Option[];
  dogBands: Option[];
}) {
  const [state, action, pending] = useActionState(editCustomerPetAction, initialState);
  const [version, setVersion] = useState(updatedAt);
  const [values, setValues] = useState(defaults);
  if (version !== updatedAt) {
    setVersion(updatedAt);
    setValues(defaults);
  }

  const update = (key: keyof CustomerPetDefaults) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = event.target.value;
    setValues((current) => ({
      ...current,
      [key]: value,
      ...(key === "species" && value !== "dog" ? { manualSize: "" } : {}),
    }));
  };
  const measuredDog = values.species === "dog" && values.weightKg.trim() !== "";

  return <details className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
    <summary className="cursor-pointer text-xs font-bold text-emerald-700">Edit data hewan</summary>
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="petId" value={petId} />
      <input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className={labelClass}>Nama<input className={inputClass} name="name" value={values.name} onChange={update("name")} required maxLength={80} /></label>
        <label className={labelClass}>Jenis<select className={inputClass} name="species" value={values.species} onChange={update("species")}>{petTypes.map((type) => <option key={type.key} value={type.key} disabled={type.disabled}>{type.label}{type.disabled ? " (nonaktif)" : ""}</option>)}</select></label>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className={labelClass}><span>Ras</span>
          {values.species === "dog" || values.species === "cat"
            ? <BreedSelect species={values.species} value={values.breed} onChange={(value) => setValues((current) => ({ ...current, breed: value }))} className={inputClass} label="Ras hewan" />
            : <input className={inputClass} name="breed" value={values.breed} onChange={update("breed")} maxLength={100} />}
          {values.species === "dog" || values.species === "cat" ? <input type="hidden" name="breed" value={values.breed} /> : null}
        </div>
        <label className={labelClass}>Jenis kelamin<select className={inputClass} name="sex" value={values.sex} onChange={update("sex")}><option value="unknown">Belum diketahui</option><option value="male">Jantan</option><option value="female">Betina</option></select></label>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <label className={labelClass}>Tanggal lahir<input className={inputClass} name="birthdate" type="date" value={values.birthdate} onChange={update("birthdate")} /></label>
        <label className={labelClass}>Berat (kg)<input className={inputClass} name="weightKg" type="number" inputMode="decimal" min="0.01" max="999" step="0.01" value={values.weightKg} onChange={update("weightKg")} /></label>
        <label className={labelClass}>Ukuran manual<select className={inputClass} name="manualSize" value={values.manualSize} onChange={update("manualSize")} disabled={values.species !== "dog" || measuredDog}><option value="">Tanpa ukuran manual</option>{dogBands.map((band) => <option key={band.key} value={band.key} disabled={band.disabled}>{band.label}{band.disabled ? " (diarsipkan)" : ""}</option>)}</select></label>
      </div>
      {values.species !== "dog" || measuredDog ? <input type="hidden" name="manualSize" value="" /> : null}
      <p className="text-[11px] leading-5 text-slate-400">
        {measuredDog ? `Ukuran tersimpan saat ini: ${currentSizeLabel ?? "—"}. Setelah disimpan, server menghitung ulang dari berat memakai kategori aktif bisnis.` : "Tanpa berat, anjing dapat memakai ukuran manual dari kategori aktif bisnis."}
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className={labelClass}>Warna<input className={inputClass} name="color" value={values.color} onChange={update("color")} maxLength={80} /></label>
        <label className={labelClass}>Temperamen<input className={inputClass} name="temperament" value={values.temperament} onChange={update("temperament")} maxLength={120} /></label>
      </div>
      <label className={`${labelClass} block`}>Catatan<textarea className={`${inputClass} h-auto py-2`} name="notes" rows={3} value={values.notes} onChange={update("notes")} maxLength={1000} /></label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setValues(defaults)} disabled={pending} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-50">Reset</button>
          <button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan hewan"}</button>
        </div>
      </div>
    </form>
  </details>;
}
