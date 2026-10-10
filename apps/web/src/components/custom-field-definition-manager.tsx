"use client";

import { useActionState } from "react";
import {
  saveCustomFieldDefinitionAction,
  setCustomFieldArchivedAction,
  type CustomFieldDefinitionState,
} from "@/app/settings/custom-fields/actions";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABELS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  type CustomFieldDefinition,
} from "@/lib/custom-fields";

const initialState: CustomFieldDefinitionState = { error: null, success: null };
const inputClass = "mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
const labelClass = "text-[11px] font-semibold text-slate-500";

function Status({ state }: { state: CustomFieldDefinitionState }) {
  return <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>;
}

function CreateForm() {
  const [state, action, pending] = useActionState(saveCustomFieldDefinitionAction, initialState);
  return <form action={action} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
    <h3 className="text-sm font-bold">Tambah isian</h3>
    <div className="grid gap-2.5 sm:grid-cols-3">
      <label className={labelClass}>Lingkup<select className={inputClass} name="entityType" defaultValue="customer">{CUSTOM_FIELD_ENTITIES.map((entity) => <option key={entity} value={entity}>{CUSTOM_FIELD_ENTITY_LABELS[entity]}</option>)}</select></label>
      <label className={labelClass}>Tipe<select className={inputClass} name="fieldType" defaultValue="text">{CUSTOM_FIELD_TYPES.map((type) => <option key={type} value={type}>{CUSTOM_FIELD_TYPE_LABELS[type]}</option>)}</select></label>
      <label className={labelClass}>Urutan<input className={inputClass} name="sortOrder" type="number" min={0} max={9999} defaultValue={0} /></label>
    </div>
    <label className={`${labelClass} block`}>Nama isian<input className={inputClass} name="label" required maxLength={60} /></label>
    <label className={`${labelClass} block`}>Pilihan (hanya untuk pilihan tunggal, satu per baris, maksimal 12)<textarea className={`${inputClass} h-auto py-2`} name="options" rows={3} /></label>
    <p className="text-[11px] leading-5 text-slate-400">Tipe dan lingkup tidak dapat diubah setelah dibuat. Isian tidak ikut pencarian, export, atau formulir publik.</p>
    <div className="flex items-center justify-between gap-2"><Status state={state} /><button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Tambah"}</button></div>
  </form>;
}

function EditRow({ definition }: { definition: CustomFieldDefinition }) {
  const [state, action, pending] = useActionState(saveCustomFieldDefinitionAction, initialState);
  const [archiveState, archiveAction, archiving] = useActionState(setCustomFieldArchivedAction, initialState);
  const archived = definition.status === "archived";
  return <li className={`rounded-2xl border p-4 ${archived ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-bold text-slate-800">{definition.label} <span className="ml-1 text-[11px] font-semibold text-slate-400">{CUSTOM_FIELD_ENTITY_LABELS[definition.entityType]} · {CUSTOM_FIELD_TYPE_LABELS[definition.fieldType]}</span></p>
      {archived ? <span className="rounded-full bg-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">Diarsipkan</span> : null}
    </div>
    {archived ? <p className="mt-1 text-[11px] text-slate-500">Nilai tersimpan dipertahankan tetapi tidak tampil atau dapat diubah sampai diaktifkan kembali.</p> : <form action={action} className="mt-3 space-y-2.5">
      <input type="hidden" name="id" value={definition.id} />
      <input type="hidden" name="expectedUpdatedAt" value={definition.updatedAt} />
      <input type="hidden" name="fieldType" value={definition.fieldType} />
      <div className="grid gap-2.5 sm:grid-cols-[1fr_7rem]">
        <label className={labelClass}>Nama<input className={inputClass} name="label" defaultValue={definition.label} required maxLength={60} /></label>
        <label className={labelClass}>Urutan<input className={inputClass} name="sortOrder" type="number" min={0} max={9999} defaultValue={definition.sortOrder} /></label>
      </div>
      {definition.fieldType === "select" ? <label className={`${labelClass} block`}>Pilihan (satu per baris)<textarea className={`${inputClass} h-auto py-2`} name="options" rows={4} defaultValue={definition.options.map((option) => option.label).join("\n")} />
        <span className="mt-1 block text-[11px] font-normal text-slate-400">Nilai tersimpan mengikuti pilihan yang namanya sama. Pilihan yang dihapus atau diganti nama tampil sebagai “tidak lagi tersedia”.</span></label> : <input type="hidden" name="options" value="" />}
      <div className="flex items-center justify-between gap-2"><Status state={state} /><button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan"}</button></div>
    </form>}
    <form action={archiveAction} className="mt-2 flex items-center justify-between gap-2">
      <input type="hidden" name="id" value={definition.id} />
      <input type="hidden" name="archived" value={archived ? "false" : "true"} />
      <Status state={archiveState} />
      <button type="submit" disabled={archiving} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 disabled:opacity-60">{archived ? "Aktifkan kembali" : "Arsipkan"}</button>
    </form>
  </li>;
}

export function CustomFieldDefinitionManager({ definitions }: { definitions: CustomFieldDefinition[] }) {
  return <div className="space-y-5">
    <CreateForm />
    {CUSTOM_FIELD_ENTITIES.map((entity) => {
      const group = definitions.filter((definition) => definition.entityType === entity);
      return <section key={entity}>
        <h3 className="mb-2 text-sm font-bold text-slate-700">Isian {CUSTOM_FIELD_ENTITY_LABELS[entity].toLowerCase()}</h3>
        {group.length === 0 ? <p className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500">Belum ada isian untuk {CUSTOM_FIELD_ENTITY_LABELS[entity].toLowerCase()}.</p>
          : <ul className="space-y-3">{group.map((definition) => <EditRow key={definition.id} definition={definition} />)}</ul>}
      </section>;
    })}
  </div>;
}
