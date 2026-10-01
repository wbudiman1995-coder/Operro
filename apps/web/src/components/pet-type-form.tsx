"use client";

import { useActionState } from "react";
import { addPetTypeAction, type PilotActionState } from "@/app/pilot-actions";
import type { PetTypeOption } from "@/components/species-pricing-fields";

const initial: PilotActionState = { error: null, success: null };

export function PetTypeForm({ petTypes }: { petTypes: PetTypeOption[] }) {
  const [state, action, pending] = useActionState(addPetTypeAction, initial);
  return <section id="jenis-pet" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Jenis pet yang dilayani</h2><p className="mt-1 text-xs text-slate-600">Anjing menggunakan XS–XL, kucing menggunakan kolom Cat. Tambahkan jenis lain di sini; setelahnya isi harga dan menit pada setiap layanan yang berlaku sebelum menerima booking.</p><div className="mt-3 flex flex-wrap gap-2">{petTypes.filter((type) => type.active).map((type) => <span key={type.key} className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800">{type.label}</span>)}</div><form action={action} className="mt-4 flex flex-wrap gap-2"><input name="label" minLength={2} maxLength={60} required placeholder="Contoh: Kelinci" aria-label="Nama jenis pet baru" className="h-10 min-w-48 flex-1 rounded-lg border px-3 text-sm" /><button disabled={pending} className="rounded-lg bg-emerald-700 px-4 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Tambah jenis"}</button></form>{state.error || state.success ? <p role="status" className={`mt-2 text-xs ${state.error ? "text-rose-700" : "text-emerald-800"}`}>{state.error ?? state.success}</p> : null}</section>;
}
