"use client";

import { useActionState } from "react";
import { createBranchBlockAction, createServedCityDateAction, removeBranchBlockAction, removeServedCityDateAction } from "@/app/schedule/actions";
import { ActionSubmitButton } from "@/components/action-submit-button";
import type { BranchAvailabilityBlock, ServedCityDate } from "@/lib/schedule";
import { IDLE_STATE } from "@/lib/schedule/idle_state";

function Feedback({ state }: { state: { error: string | null; success: string | null } }) {
  return state.error || state.success ? <p role="status" className={`rounded-lg px-3 py-2 text-xs font-semibold ${state.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-800"}`}>{state.error ?? state.success}</p> : null;
}

export function BranchAvailabilityManager({ branchId, defaultDateISO, timeZone, blocks, servedCities }: { branchId: string; defaultDateISO: string; timeZone: string; blocks: readonly BranchAvailabilityBlock[]; servedCities: readonly ServedCityDate[] }) {
  const [blockState, createBlock] = useActionState(createBranchBlockAction, IDLE_STATE);
  const [removeBlockState, removeBlock] = useActionState(removeBranchBlockAction, IDLE_STATE);
  const [cityState, createCity] = useActionState(createServedCityDateAction, IDLE_STATE);
  const [removeCityState, removeCity] = useActionState(removeServedCityDateAction, IDLE_STATE);
  return <section className="mt-4 grid gap-4 lg:grid-cols-2">
    <div className="rounded-2xl border border-rose-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold text-slate-800">Penutupan seluruh cabang</h2><p className="mt-1 text-[11px] text-slate-500">Memblokir semua groomer dan booking baru pada rentang ini · {timeZone}.</p>
      <form action={createBlock} className="mt-3 grid gap-2 sm:grid-cols-2"><input type="hidden" name="branchId" value={branchId}/><input type="date" name="dateISO" defaultValue={defaultDateISO} required aria-label="Tanggal penutupan" className="h-10 rounded-xl border px-2 text-sm"/><input type="text" name="reason" maxLength={500} placeholder="Alasan penutupan" aria-label="Alasan penutupan" className="h-10 rounded-xl border px-2 text-sm"/><input type="time" name="startTime" defaultValue="08:00" required aria-label="Mulai penutupan" className="h-10 rounded-xl border px-2 text-sm"/><input type="time" name="endTime" defaultValue="18:00" required aria-label="Selesai penutupan" className="h-10 rounded-xl border px-2 text-sm"/><div className="sm:col-span-2"><Feedback state={blockState}/><ActionSubmitButton pendingLabel="Menyimpan…" className="mt-2 w-full rounded-xl bg-rose-700 px-3 py-2.5 text-xs font-bold text-white">Tutup seluruh cabang</ActionSubmitButton></div></form>
      <div className="mt-3 space-y-2">{blocks.map((item)=><div key={item.id} className="flex items-center justify-between gap-2 rounded-xl bg-rose-50 p-3"><div><p className="text-xs font-bold text-rose-900">{item.dateISO} · {item.startLabel}–{item.endLabel}</p><p className="text-[11px] text-rose-700">{item.reason ?? "Tanpa alasan"}</p></div><form action={removeBlock}><input type="hidden" name="branchId" value={branchId}/><input type="hidden" name="blockId" value={item.id}/><input type="hidden" name="confirm" value="yes"/><ActionSubmitButton pendingLabel="…" className="rounded-lg border border-rose-200 bg-white px-2 py-1 text-[11px] font-bold text-rose-700">Hapus</ActionSubmitButton></form></div>)}{blocks.length===0?<p className="text-xs text-slate-400">Tidak ada penutupan cabang pada periode ini.</p>:null}<Feedback state={removeBlockState}/></div>
    </div>
    <div className="rounded-2xl border border-cyan-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold text-slate-800">Kota layanan per tanggal</h2><p className="mt-1 text-[11px] text-slate-500">Bantu penjadwalan home service mengelompokkan kunjungan dalam kota yang sama.</p>
      <form action={createCity} className="mt-3 grid gap-2 sm:grid-cols-2"><input type="hidden" name="branchId" value={branchId}/><input type="date" name="serviceDate" defaultValue={defaultDateISO} required aria-label="Tanggal layanan kota" className="h-10 rounded-xl border px-2 text-sm"/><input type="text" name="city" required maxLength={120} placeholder="Kabupaten / kota" aria-label="Kabupaten atau kota" className="h-10 rounded-xl border px-2 text-sm"/><input type="text" name="notes" maxLength={500} placeholder="Catatan area (opsional)" aria-label="Catatan kota" className="h-10 rounded-xl border px-2 text-sm sm:col-span-2"/><div className="sm:col-span-2"><Feedback state={cityState}/><ActionSubmitButton pendingLabel="Menyimpan…" className="mt-2 w-full rounded-xl bg-cyan-700 px-3 py-2.5 text-xs font-bold text-white">Tambah kota layanan</ActionSubmitButton></div></form>
      <div className="mt-3 space-y-2">{servedCities.map((item)=><div key={item.id} className="flex items-center justify-between gap-2 rounded-xl bg-cyan-50 p-3"><div><p className="text-xs font-bold text-cyan-900">{item.serviceDate} · {item.city}</p><p className="text-[11px] text-cyan-700">{item.notes ?? "Siap menerima home service"}</p></div><form action={removeCity}><input type="hidden" name="branchId" value={branchId}/><input type="hidden" name="servedCityId" value={item.id}/><input type="hidden" name="confirm" value="yes"/><ActionSubmitButton pendingLabel="…" className="rounded-lg border border-cyan-200 bg-white px-2 py-1 text-[11px] font-bold text-cyan-700">Hapus</ActionSubmitButton></form></div>)}{servedCities.length===0?<p className="text-xs text-slate-400">Belum ada kota khusus pada periode ini.</p>:null}<Feedback state={removeCityState}/></div>
    </div>
  </section>;
}
