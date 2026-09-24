"use client";

import { useActionState, useState } from "react";

import { archiveResourceAction, updateResourceAction, updateResourceCompensationAction, type PilotActionState } from "@/app/pilot-actions";
import { MapsCoordinateFields } from "@/components/customer-address-forms";
import type { CatalogWorkspace } from "@/lib/pilot-data";

const initialState: PilotActionState = { error: null, success: null };
const field = "h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";

function Message({ state }: { state: PilotActionState }) {
  return state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null;
}

export function ResourceManager({ resource, branches, memberships, canManageResource, canManagePayroll }: { resource: CatalogWorkspace["resources"][number]; branches: CatalogWorkspace["branches"]; memberships: CatalogWorkspace["memberships"]; canManageResource: boolean; canManagePayroll: boolean }) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [updateState, updateAction, updating] = useActionState(updateResourceAction, initialState);
  const [archiveState, archiveAction, archiving] = useActionState(archiveResourceAction, initialState);
  const [payState, payAction, paying] = useActionState(updateResourceCompensationAction, initialState);
  const schedulePath = `/schedule?branch=${resource.branchId}&groomer=${resource.id}`;

  async function copyScheduleLink() {
    await navigator.clipboard.writeText(`${window.location.origin}${schedulePath}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return <article className="p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: resource.color }} /><p className="truncate font-bold">{resource.name}</p></div>
        <p className="mt-1 text-xs text-slate-500">{resource.branchName} · {resource.phone ?? "Telepon belum diisi"}</p>
        <p className="mt-1 text-[11px] text-slate-400">Bergabung {new Date(resource.joinDate).toLocaleDateString("id-ID")} · {resource.appointmentCount} booking</p>
        <p className={`mt-1 text-[11px] font-semibold ${resource.lateCount || resource.missingPhotoCount ? "text-amber-700" : "text-emerald-700"}`}>Bulan ini: {resource.lateCount} terlambat · {resource.missingPhotoCount} tanpa foto</p>
        {resource.baseLabel ? <p className="mt-1 text-[11px] text-slate-500">Base: {resource.baseLabel}</p> : null}
        {resource.baseSalary !== null ? <p className="mt-1 text-[11px] font-semibold text-slate-600">Kompensasi {resource.payType}: Rp{resource.baseSalary.toLocaleString("id-ID")}</p> : null}
      </div>
      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${resource.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{resource.status}</span>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <a href={schedulePath} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-800">Buka jadwal</a>
      <button type="button" onClick={copyScheduleLink} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700">{copied ? "Tersalin" : "Salin link jadwal"}</button>
      {canManageResource ? <button type="button" onClick={() => setEditing((value) => !value)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700">{editing ? "Tutup" : "Edit"}</button> : null}
    </div>
    {editing ? <form action={updateAction} className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-4">
      <input type="hidden" name="resourceId" value={resource.id} />
      <input className={field} name="name" defaultValue={resource.name} required />
      <div className="grid gap-3 sm:grid-cols-2"><input className={field} name="phone" defaultValue={resource.phone ?? ""} placeholder="Telepon / WhatsApp" /><input className={`${field} p-1`} type="color" name="color" defaultValue={resource.color} aria-label="Warna kalender" /></div>
      <div className="grid gap-3 sm:grid-cols-2"><select className={field} name="branchId" defaultValue={resource.branchId}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={field} name="status" defaultValue={resource.status}><option value="active">Aktif</option><option value="maintenance">Nonaktif sementara</option><option value="retired">Pensiun</option></select></div>
      <select className={field} name="membershipId" defaultValue={resource.membershipId ?? ""}><option value="">Tanpa akun staf</option>{memberships.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <input className={field} name="baseLabel" defaultValue={resource.baseLabel ?? ""} placeholder="Alamat / titik keberangkatan" />
      <MapsCoordinateFields initialLatitude={resource.latitude} initialLongitude={resource.longitude} />
      <Message state={updateState} />
      <button disabled={updating} className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{updating ? "Menyimpan…" : "Simpan groomer"}</button>
    </form> : null}
    {editing && canManagePayroll && resource.membershipId ? <form action={payAction} className="mt-3 space-y-3 rounded-2xl border border-amber-100 bg-amber-50/60 p-4">
      <input type="hidden" name="resourceId" value={resource.id} /><input type="hidden" name="membershipId" value={resource.membershipId} />
      <p className="text-[11px] font-bold uppercase tracking-wide text-amber-800">Kompensasi</p>
      <div className="grid gap-3 sm:grid-cols-2"><select className={field} name="payType" defaultValue={resource.payType ?? "salary"}><option value="salary">Gaji bulanan</option><option value="hourly">Per jam</option></select><input className={field} name="baseAmount" type="number" min="0" step="1000" defaultValue={resource.baseSalary ?? 0} aria-label="Gaji pokok" /></div>
      <Message state={payState} /><button disabled={paying} className="rounded-xl bg-amber-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{paying ? "Menyimpan…" : "Simpan kompensasi"}</button>
    </form> : null}
    {canManageResource ? <form action={archiveAction} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="resourceId" value={resource.id} /><input type="hidden" name="confirm" value="yes" />
      <button disabled={archiving} className="text-[11px] font-bold text-rose-600 disabled:opacity-50">Arsipkan groomer</button><Message state={archiveState} />
    </form> : null}
  </article>;
}
