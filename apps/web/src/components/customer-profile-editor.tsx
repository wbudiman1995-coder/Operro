"use client";

import { useActionState, useState, type ChangeEvent } from "react";
import { editCustomerProfileAction, type CustomerProfileEditState } from "@/app/customers/[customerId]/actions";

const initialState: CustomerProfileEditState = { error: null, success: null };
const inputClass = "mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
const labelClass = "text-[11px] font-semibold text-slate-500";

export interface CustomerProfileDefaults {
  displayName: string;
  phone: string;
  email: string;
  source: string;
  notes: string;
}

export function CustomerProfileEditor({ customerId, updatedAt, defaults }: { customerId: string; updatedAt: string; defaults: CustomerProfileDefaults }) {
  const [state, action, pending] = useActionState(editCustomerProfileAction, initialState);
  const [version, setVersion] = useState(updatedAt);
  const [values, setValues] = useState<CustomerProfileDefaults>(defaults);

  if (version !== updatedAt) {
    setVersion(updatedAt);
    setValues(defaults);
  }

  const update = (key: keyof CustomerProfileDefaults) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  return <details className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
    <summary className="cursor-pointer text-sm font-bold text-emerald-700">Edit profil</summary>
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className={labelClass}>Nama<input className={inputClass} name="display_name" value={values.displayName} onChange={update("displayName")} required maxLength={120} /></label>
        <label className={labelClass}>Telepon<input className={inputClass} name="phone" value={values.phone} onChange={update("phone")} maxLength={40} /></label>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className={labelClass}>Email<input className={inputClass} name="email" type="email" value={values.email} onChange={update("email")} maxLength={254} /></label>
        <label className={labelClass}>Sumber<input className={inputClass} name="source" list="source-label-suggestions" value={values.source} onChange={update("source")} maxLength={80} /></label>
      </div>
      <label className={`${labelClass} block`}>Catatan<textarea className={`${inputClass} h-auto py-2`} name="notes" rows={4} value={values.notes} onChange={update("notes")} maxLength={4000} /></label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" role="status" className="text-xs font-semibold">
          {state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setValues(defaults)} disabled={pending} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-50">Reset</button>
          <button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan perubahan"}</button>
        </div>
      </div>
    </form>
  </details>;
}
