"use client";

import { useActionState } from "react";

import { updateInvoiceCustomerNotesAction, type DocumentSettingsActionState } from "@/app/document-settings-actions";

const initialState: DocumentSettingsActionState = { error: null, success: null };

export function InvoiceCustomerNotesEditor({ invoiceId, revision, initialNotes }: { invoiceId: string; revision: number; initialNotes: string }) {
  const [state, action, pending] = useActionState(updateInvoiceCustomerNotesAction, initialState);
  return <form action={action} className="print:hidden mt-2 space-y-2">
    <input type="hidden" name="invoiceId" value={invoiceId} />
    <input type="hidden" name="revision" value={revision} />
    <textarea name="notes" defaultValue={initialNotes} rows={2} placeholder="Catatan groomer untuk pelanggan (opsional)" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
    <div className="flex items-center gap-2">
      <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Simpan catatan"}</button>
      {state.error ? <span className="text-[10px] font-semibold text-rose-600">{state.error}</span> : state.success ? <span className="text-[10px] font-semibold text-emerald-700">{state.success}</span> : null}
    </div>
  </form>;
}
