"use client";

import { useActionState } from "react";

import { updateInvoiceDetailsAction } from "@/app/invoices/actions";
import type { PilotActionState } from "@/app/pilot-actions";

const initial: PilotActionState = { error: null, success: null };
const field = "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm";

export function InvoiceDetailsEditor({ invoice, groomers }: { invoice: { id: string; branchId: string; issuedAt: string; dueAt: string | null; documentType: string; groomerId: string | null; groomerName: string | null; adminNotes: string | null; revision: number }; groomers: Array<{ id: string; branchId: string; name: string }> }) {
  const [state, action, pending] = useActionState(updateInvoiceDetailsAction, initial);
  const branchGroomers = groomers.filter((item) => item.branchId === invoice.branchId);
  return <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left"><summary className="cursor-pointer text-xs font-bold text-emerald-700">Edit detail invoice belum dibayar</summary><form action={action} className="mt-3 space-y-3"><input type="hidden" name="invoiceId" value={invoice.id} /><input type="hidden" name="revision" value={invoice.revision} /><div className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold">Tanggal invoice<input className={`${field} mt-1`} type="date" name="invoiceDate" defaultValue={invoice.issuedAt.slice(0, 10)} required /></label><label className="text-xs font-semibold">Jatuh tempo<input className={`${field} mt-1`} type="date" name="dueDate" defaultValue={invoice.dueAt?.slice(0, 10) ?? ""} /></label></div><div className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold">Jenis dokumen<select className={`${field} mt-1`} name="documentType" defaultValue={invoice.documentType}><option value="invoice">Invoice</option><option value="service_report">Laporan layanan prepaid</option></select></label><label className="text-xs font-semibold">Groomer<select className={`${field} mt-1`} name="groomerId" defaultValue={invoice.groomerId ?? ""}><option value="">Nama manual / tidak ditentukan</option>{branchGroomers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><input className={field} name="manualGroomer" defaultValue={invoice.groomerId ? "" : invoice.groomerName ?? ""} placeholder="Nama groomer manual" /><textarea className="min-h-20 w-full rounded-lg border border-slate-200 bg-white p-3 text-sm" name="adminNotes" defaultValue={invoice.adminNotes ?? ""} placeholder="Catatan internal" />{state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}<button disabled={pending} className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan detail"}</button></form></details>;
}
