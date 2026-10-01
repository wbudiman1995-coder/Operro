"use client";

import { useActionState, useState } from "react";
import { saveSizeBandsAction, type SizeBoundaryState } from "@/app/catalog/actions";
import type { DogSizeBand } from "@/lib/pet-sizing";

const initial: SizeBoundaryState = { error: null, success: null };
const input = "mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm";

export function DogSizeBandsForm({ initialBands }: { initialBands: DogSizeBand[] }) {
  const [bands, setBands] = useState<DogSizeBand[]>(initialBands);
  const [state, action, pending] = useActionState(saveSizeBandsAction, initial);
  const existingKeys = new Set(initialBands.map((band) => band.key));
  const patch = (index: number, fields: Partial<DogSizeBand>) => setBands((current) => current.map((band, position) => position === index ? { ...band, ...fields } : band));
  const add = () => setBands((current) => {
    if (current.length >= 20) return current;
    const previous = current.length > 1 ? current[current.length - 2].upperKg : 0;
    const cutoff = Math.min(999, Number(previous ?? 0) + 10);
    const next = current.map((band, index) => index === current.length - 1 ? { ...band, upperKg: cutoff } : band);
    const proposed = current.at(-1)?.key === "extra_large" ? "xxl" : "new_size";
    const key = current.some((band) => band.key === proposed) ? `size_${Date.now().toString(36)}` : proposed;
    return [...next, { key, label: key === "xxl" ? "XXL" : "Ukuran baru", upperKg: null }];
  });
  const remove = (index: number) => setBands((current) => current.length === 1 ? current : current.filter((_, position) => position !== index).map((band, position, remaining) =>
    position === remaining.length - 1 ? { ...band, upperKg: null } : band));
  const move = (index: number, direction: -1 | 1) => setBands((current) => {
    const target = index + direction; if (target < 0 || target >= current.length) return current;
    const next = [...current]; [next[index], next[target]] = [next[target], next[index]];
    return next.map((band, position) => ({ ...band, upperKg: current[position].upperKg }));
  });
  return <section id="batas-ukuran" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <h2 className="font-bold">Kategori ukuran anjing</h2>
    <p className="mt-1 text-xs leading-5 text-slate-500">Pemilik bisnis dapat menambah XXL atau ukuran lain, mengganti nama, mengurutkan, dan menghapus ukuran yang tidak dipakai. Kode lama tetap supaya paket dan histori terbaca. Batas berarti berat kurang dari angka KG; kategori terakhir mencakup sisanya. Harga dan durasi diatur pada matriks layanan.</p>
    <form action={action} className="mt-4 space-y-3">
      <input type="hidden" name="bandsJson" value={JSON.stringify(bands)} />
      {bands.map((band, index) => <div key={index} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_130px_auto]">
        <label className="text-xs font-semibold">Nama kategori<input className={input} value={band.label} onChange={(event) => patch(index, { label: event.target.value })} maxLength={24} required /></label>
        <label className="text-xs font-semibold">Kode stabil<input className={input} value={band.key} onChange={(event) => patch(index, { key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} disabled={existingKeys.has(band.key)} maxLength={30} required /></label>
        <label className="text-xs font-semibold">{index === bands.length - 1 ? "Tanpa batas" : "Kurang dari KG"}<input className={input} type="number" min="0.01" max="999" step="0.01" value={band.upperKg ?? ""} onChange={(event) => patch(index, { upperKg: event.target.value === "" ? null : Number(event.target.value) })} disabled={index === bands.length - 1} required={index < bands.length - 1} /></label>
        <div className="flex items-end gap-1"><button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Naikkan ${band.label}`} className="rounded-lg border px-2 py-2 text-xs disabled:opacity-30">↑</button><button type="button" onClick={() => move(index, 1)} disabled={index === bands.length - 1} aria-label={`Turunkan ${band.label}`} className="rounded-lg border px-2 py-2 text-xs disabled:opacity-30">↓</button><button type="button" onClick={() => remove(index)} disabled={bands.length === 1} className="rounded-lg border border-rose-200 px-2 py-2 text-xs font-bold text-rose-700 disabled:opacity-30">Hapus</button></div>
      </div>)}
      <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={add} disabled={bands.length >= 20} className="rounded-lg border border-emerald-300 px-4 py-2 text-xs font-bold text-emerald-700">+ Tambah ukuran</button><button disabled={pending} className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan kategori ukuran"}</button></div>
      {state.error || state.success ? <p role="status" className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}
    </form>
  </section>;
}
