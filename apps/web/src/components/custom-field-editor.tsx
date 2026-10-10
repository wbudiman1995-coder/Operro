"use client";

import { useActionState, useState } from "react";
import { saveCustomFieldValuesAction, type CustomFieldValuesState } from "@/app/customers/[customerId]/custom-field-actions";
import type { CustomFieldDefinition, CustomFieldEntity } from "@/lib/custom-fields";

const initialState: CustomFieldValuesState = { error: null, success: null };
const inputClass = "mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
const labelClass = "text-[11px] font-semibold text-slate-500";

/** Editable owner-defined fields for one customer or pet. `initial` maps definition id -> submitted-form text. */
export function CustomFieldEditor({
  entityType,
  entityId,
  customerId,
  definitions,
  initial,
}: {
  entityType: CustomFieldEntity;
  entityId: string;
  customerId: string;
  definitions: CustomFieldDefinition[];
  initial: Record<string, string>;
}) {
  const [state, action, pending] = useActionState(saveCustomFieldValuesAction, initialState);
  const [values, setValues] = useState(initial);
  if (definitions.length === 0) return null;
  const set = (id: string, value: string) => setValues((current) => ({ ...current, [id]: value }));

  return <details className="mt-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
    <summary className="cursor-pointer text-xs font-bold text-emerald-700">Isian tambahan</summary>
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="customerId" value={customerId} />
      <div className="grid gap-2.5 sm:grid-cols-2">
        {definitions.map((definition) => {
          const name = `cf_${definition.id}`;
          const value = values[definition.id] ?? "";
          if (definition.fieldType === "select") {
            const missing = value !== "" && !definition.options.some((option) => option.key === value);
            return <label key={definition.id} className={labelClass}>{definition.label}
              <select className={inputClass} name={name} value={value} onChange={(event) => set(definition.id, event.target.value)}>
                <option value="">Kosong</option>
                {missing ? <option value={value} disabled>Pilihan lama (tidak lagi tersedia)</option> : null}
                {definition.options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select></label>;
          }
          if (definition.fieldType === "boolean") {
            return <label key={definition.id} className={labelClass}>{definition.label}
              <select className={inputClass} name={name} value={value} onChange={(event) => set(definition.id, event.target.value)}>
                <option value="">Kosong</option><option value="true">Ya</option><option value="false">Tidak</option>
              </select></label>;
          }
          return <label key={definition.id} className={labelClass}>{definition.label}
            <input className={inputClass} name={name} type={definition.fieldType === "date" ? "date" : "text"}
              inputMode={definition.fieldType === "number" ? "decimal" : undefined}
              maxLength={definition.fieldType === "text" ? 200 : undefined} value={value} onChange={(event) => set(definition.id, event.target.value)} /></label>;
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
        <button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan isian"}</button>
      </div>
    </form>
  </details>;
}
