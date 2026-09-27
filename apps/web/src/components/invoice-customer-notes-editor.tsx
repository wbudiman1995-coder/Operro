"use client";

import { useState } from "react";
import { useActionState } from "react";

import { updateInvoiceCustomerNotesAction, type DocumentSettingsActionState } from "@/app/document-settings-actions";

const initialState: DocumentSettingsActionState = { error: null, success: null };

/**
 * C4: internal groomer instructions (grooming_jobs.groomer_notes) and the
 * customer-facing note on this invoice (invoices.customer_notes) are
 * DISTINCT fields — the internal one is never rendered on the document or
 * sent to the customer automatically. "Salin ke catatan pelanggan" is the
 * explicit review/copy step: it only pre-fills this form's own textarea: it
 * still requires a human to look at the copied text and press Simpan before
 * anything becomes customer-facing.
 */
export function InvoiceCustomerNotesEditor({ invoiceId, revision, initialNotes, internalNote }: { invoiceId: string; revision: number; initialNotes: string; internalNote: string | null }) {
  const [state, action, pending] = useActionState(updateInvoiceCustomerNotesAction, initialState);
  const [notes, setNotes] = useState(initialNotes);
  return <div className="print:hidden mt-2 space-y-2">
    {internalNote ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
      <p className="text-[10px] font-bold uppercase text-amber-700">Catatan internal groomer (tidak terlihat pelanggan)</p>
      <p className="mt-1 whitespace-pre-line text-xs text-amber-900">{internalNote}</p>
      <button type="button" onClick={() => setNotes(internalNote)} className="mt-1 text-[10px] font-bold text-amber-700 underline">Salin ke catatan pelanggan</button>
    </div> : null}
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="revision" value={revision} />
      <textarea name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Catatan groomer untuk pelanggan (opsional)" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
      <div className="flex items-center gap-2">
        <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Simpan catatan"}</button>
        {state.error ? <span className="text-[10px] font-semibold text-rose-600">{state.error}</span> : state.success ? <span className="text-[10px] font-semibold text-emerald-700">{state.success}</span> : null}
      </div>
    </form>
  </div>;
}
