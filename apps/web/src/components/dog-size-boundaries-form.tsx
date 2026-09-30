"use client";

import { useActionState } from "react";
import { saveSizeBoundariesAction, type SizeBoundaryState } from "@/app/catalog/actions";

const initial: SizeBoundaryState = { error: null, success: null };
export function DogSizeBoundariesForm({ initialValues }: { initialValues: { xs: number; s: number; m: number; l: number } }) {
  const [state, action, pending] = useActionState(saveSizeBoundariesAction, initial);
  return <section id="batas-ukuran" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Kategori ukuran anjing berdasarkan berat</h2><p className="mt-1 text-xs leading-5 text-slate-500">Atur batas KG untuk XS, S, M, dan L. XL di atas batas L; Cat selalu kategori terpisah. Harga dan durasi tiap kategori diatur pada matriks di bawah. Perubahan hanya memengaruhi booking baru.</p><form action={action} className="mt-4 grid gap-3 sm:grid-cols-4">{([['xs','XS jika kurang dari'],['s','S jika kurang dari'],['m','M jika kurang dari'],['l','L sampai dengan']] as const).map(([name,label]) => <label key={name} className="text-xs font-semibold text-slate-700">{label} (kg)<input type="number" name={name} min="0.01" max="999" step="0.01" required defaultValue={initialValues[name]} className="mt-1 h-10 w-full rounded-lg border px-3" /></label>)}<div className="sm:col-span-4"><p className="mb-3 text-xs text-slate-500">Saat ini: XS &lt; {initialValues.xs} kg · S &lt; {initialValues.s} kg · M &lt; {initialValues.m} kg · L ≤ {initialValues.l} kg · XL &gt; {initialValues.l} kg · Cat terpisah.</p><button disabled={pending} className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan kategori ukuran"}</button>{state.error || state.success ? <p role="status" className={`mt-2 text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}</div></form></section>;
}
