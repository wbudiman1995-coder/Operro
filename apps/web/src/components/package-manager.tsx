"use client";

import { useActionState, useState } from "react";

import { updatePackageAction, type PilotActionState } from "@/app/pilot-actions";
import type { CatalogWorkspace } from "@/lib/pilot-data";
import { formatRupiah } from "@/lib/pilot-data";

const initialState: PilotActionState = { error: null, success: null };
const field = "h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";

function Message({ state }: { state: PilotActionState }) {
  return state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null;
}

const RECURRENCE_LABEL: Record<string, string> = { none: "sekali beli", week: "mingguan", month: "bulanan", year: "tahunan" };

/** Section 24: edits a catalog package's terms. Never touches already-sold customer_packages rows (see updatePackageAction). */
export function PackageManager({ pkg, services, canManage }: { pkg: CatalogWorkspace["packages"][number]; services: Array<{ id: string; name: string }>; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(updatePackageAction, initialState);

  return <article className="p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-bold">{pkg.name}{pkg.perPet ? <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase text-indigo-700">Per hewan</span> : null}</p>
        <p className="mt-1 text-xs text-slate-500">{pkg.sessions} sesi · {formatRupiah(pkg.price)} · {RECURRENCE_LABEL[pkg.recurrenceInterval] ?? pkg.recurrenceInterval}</p>
        <p className="mt-1 text-[11px] text-slate-400">{pkg.validityDays ? `Berlaku ${pkg.validityDays} hari` : "Tanpa masa berlaku"} · {services.find((service) => service.id === pkg.serviceId)?.name ?? "Semua layanan"}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${pkg.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{pkg.active ? "active" : "inactive"}</span>
        {canManage ? <button type="button" onClick={() => setEditing((value) => !value)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700">{editing ? "Tutup" : "Edit"}</button> : null}
      </div>
    </div>
    {editing ? <form action={action} className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-4">
      <input type="hidden" name="packageId" value={pkg.id} />
      <input className={field} name="name" defaultValue={pkg.name} required />
      <input className={field} name="description" defaultValue={pkg.description ?? ""} placeholder="Deskripsi (opsional)" />
      <div className="grid gap-3 sm:grid-cols-2">
        <input className={field} type="number" min="1" step="1" name="sessions" defaultValue={pkg.sessions} required />
        <input className={field} type="number" min="0" step="1000" name="price" defaultValue={pkg.price} required />
      </div>
      <select className={field} name="serviceId" defaultValue={pkg.serviceId ?? ""} aria-label="Berlaku untuk layanan">
        <option value="">Berlaku untuk semua layanan</option>
        {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
      </select>
      <div className="grid gap-3 sm:grid-cols-3">
        <input className={field} type="number" min="1" step="1" name="validityDays" defaultValue={pkg.validityDays ?? ""} placeholder="Masa berlaku (hari)" />
        <select className={field} name="recurrenceInterval" defaultValue={pkg.recurrenceInterval} aria-label="Interval perpanjangan">
          <option value="none">Sekali beli (tidak berulang)</option><option value="week">Mingguan</option><option value="month">Bulanan</option><option value="year">Tahunan</option>
        </select>
        <select className={field} name="rolloverPolicy" defaultValue={pkg.rolloverPolicy} aria-label="Kebijakan rollover">
          <option value="none">Sesi tidak digabung</option><option value="rollover">Sesi bisa digabung (rollover)</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-slate-700">
        <label className="flex items-center gap-2"><input type="checkbox" name="perPet" defaultChecked={pkg.perPet} />Khusus satu hewan per pembelian</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={pkg.active} />Aktif (bisa dijual)</label>
      </div>
      <Message state={state} />
      <button disabled={pending} className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan paket"}</button>
    </form> : null}
  </article>;
}
