"use client";

/**
 * Section 30 — visit register UI: search/customer/pet/invoiced-status
 * filters, newest/oldest sort, manual visit creation, mark-billed/undo,
 * safe delete, and session-source badges. Filtering/sorting/pagination are
 * all server-side now (app.search_visit_register) — the filter bar is a
 * native GET form (selects auto-submit on change) that navigates with new
 * search params, not client-side re-filtering of an already-fetched array.
 */
import { useActionState, useState } from "react";

import {
  createInvoiceFromManualVisitAction,
  createManualVisitAction,
  deleteManualVisitAction,
  markVisitManuallyBilledAction,
  setVisitAutoLogEnabledAction,
  undoManualBillingAction,
} from "@/app/visit-actions";
import type { VisitActionState } from "@/app/visit-actions";
import { formatRupiah } from "@/lib/pilot-data";
import type { InvoicedStatus, VisitRegisterPage } from "@/lib/visit-register";

const initialState: VisitActionState = { error: null, success: null };

const invoicedLabel: Record<InvoicedStatus, string> = { invoiced: "Sudah invoice", manually_billed: "Tertagih manual", unbilled: "Belum tertagih" };
const invoicedTone: Record<InvoicedStatus, string> = { invoiced: "bg-emerald-100 text-emerald-800", manually_billed: "bg-amber-100 text-amber-800", unbilled: "bg-slate-100 text-slate-600" };

function inputClass() {
  return "h-10 w-full rounded-xl border border-slate-200 px-3 text-sm";
}

function ManualVisitForm({ branches, customers, pets }: { branches: Array<{ id: string; name: string }>; customers: Array<{ id: string; name: string }>; pets: Array<{ id: string; name: string; customerId: string }> }) {
  const [state, action, pending] = useActionState(createManualVisitAction, initialState);
  const [customerId, setCustomerId] = useState("");
  const petsForCustomer = pets.filter((p) => p.customerId === customerId);
  return <form action={action} className="grid gap-3 sm:grid-cols-2">
    <select className={inputClass()} name="branchId" required><option value="">Cabang</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
    <select className={inputClass()} name="customerId" required value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Pelanggan</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
    <select className={inputClass()} name="petId"><option value="">Hewan (opsional)</option>{petsForCustomer.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <select className={inputClass()} name="fulfillmentMode" defaultValue="in_store"><option value="in_store">Di toko</option><option value="home">Home service</option><option value="pickup_delivery">Antar-jemput</option></select>
    <input className={inputClass()} type="datetime-local" name="visitAt" required />
    <input className={inputClass()} name="description" placeholder="Layanan yang dilakukan" required />
    <input className={`${inputClass()} sm:col-span-2`} name="note" placeholder="Catatan (opsional)" />
    <div className="sm:col-span-2 flex items-center justify-between gap-3">
      {state.error ? <p className="text-xs font-semibold text-rose-600">{state.error}</p> : state.success ? <p className="text-xs font-semibold text-emerald-700">{state.success}</p> : <span />}
      <button className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Menyimpan..." : "Catat kunjungan manual"}</button>
    </div>
  </form>;
}

function AutoLogToggle({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(setVisitAutoLogEnabledAction, initialState);
  return <form action={action} className="flex items-center gap-2">
    <input type="hidden" name="enabled" value={String(!enabled)} />
    <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-60" disabled={pending}>
      {pending ? "..." : enabled ? "Matikan pencatatan otomatis" : "Aktifkan pencatatan otomatis"}
    </button>
    {state.error ? <span className="text-[10px] font-semibold text-rose-600">{state.error}</span> : null}
  </form>;
}

function MarkBilledForm({ sourceType, sourceId }: { sourceType: "booking" | "manual_visit"; sourceId: string }) {
  const [state, action, pending] = useActionState(markVisitManuallyBilledAction, initialState);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-amber-500 px-3 py-1.5 text-xs font-bold text-amber-700">Tandai tertagih manual</button>;
  return <form action={action} className="flex items-center gap-2">
    <input type="hidden" name="sourceType" value={sourceType} /><input type="hidden" name="sourceId" value={sourceId} />
    <input className="h-9 w-28 rounded-lg border border-slate-200 px-2 text-xs" type="number" min="1" name="amount" placeholder="Jumlah" required />
    <input className="h-9 w-32 rounded-lg border border-slate-200 px-2 text-xs" name="note" placeholder="Catatan" />
    <button className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Simpan"}</button>
    {state.error ? <span className="text-[10px] font-semibold text-rose-600">{state.error}</span> : null}
  </form>;
}

function UndoBillingButton({ billingId }: { billingId: string }) {
  const [state, action, pending] = useActionState(undoManualBillingAction, initialState);
  return <form action={action} className="inline-flex flex-col items-end gap-1">
    <input type="hidden" name="billingId" value={billingId} />
    <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-60" disabled={pending}>{pending ? "..." : "Batalkan penagihan"}</button>
    {state.error ? <span className="text-[10px] font-semibold text-rose-600">{state.error}</span> : null}
  </form>;
}

function DeleteVisitButton({ visitId }: { visitId: string }) {
  const [state, action, pending] = useActionState(deleteManualVisitAction, initialState);
  return <form action={action} className="inline-flex flex-col items-end gap-1">
    <input type="hidden" name="visitId" value={visitId} />
    <button className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-bold text-rose-700 disabled:opacity-60" disabled={pending}>{pending ? "..." : "Hapus"}</button>
    {state.error ? <span className="text-[10px] font-semibold text-rose-600">{state.error}</span> : null}
  </form>;
}

function CreateInvoiceFromVisitForm({ visitId }: { visitId: string }) {
  const [state, action, pending] = useActionState(createInvoiceFromManualVisitAction, initialState);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-emerald-600 px-3 py-1.5 text-xs font-bold text-emerald-700">Buat invoice</button>;
  return <form action={action} className="flex items-center gap-2">
    <input type="hidden" name="visitId" value={visitId} /><input type="hidden" name="requestKey" value={requestKey} />
    <input className="h-9 w-28 rounded-lg border border-slate-200 px-2 text-xs" type="number" min="1" name="amount" placeholder="Jumlah" required />
    <button className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Terbitkan"}</button>
    {state.error ? <span className="text-[10px] font-semibold text-rose-600">{state.error}</span> : null}
  </form>;
}

interface VisitFilters { search: string; customerId: string; petId: string; invoicedStatus: InvoicedStatus | "all"; sort: "newest" | "oldest" }

function buildVisitHref(filters: VisitFilters, cursor: string): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.petId) params.set("petId", filters.petId);
  if (filters.invoicedStatus && filters.invoicedStatus !== "all") params.set("status", filters.invoicedStatus);
  if (filters.sort && filters.sort !== "newest") params.set("sort", filters.sort);
  params.set("cursor", cursor);
  return `/visits?${params.toString()}#daftar-kunjungan`;
}

export function VisitRegister({ page, filters, autoLogEnabled, branches, customers, pets }: {
  page: VisitRegisterPage; filters: VisitFilters; autoLogEnabled: boolean;
  branches: Array<{ id: string; name: string }>; customers: Array<{ id: string; name: string }>; pets: Array<{ id: string; name: string; customerId: string }>;
}) {
  const petsForFilter = filters.customerId ? pets.filter((p) => p.customerId === filters.customerId) : pets;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) => e.currentTarget.form?.requestSubmit();

  return <div className="space-y-6">
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-bold">Catat kunjungan lampau</h2><p className="mt-1 text-xs text-slate-500">Hanya untuk layanan yang sudah terjadi di luar Operro. Untuk janji mendatang, pilih ruang kosong di Kalender.</p></div>
        <AutoLogToggle enabled={autoLogEnabled} />
      </div>
      <ManualVisitForm branches={branches} customers={customers} pets={pets} />
    </section>

    <form action="/visits" method="get" id="daftar-kunjungan" className="grid gap-3 sm:grid-cols-6">
      <input className={inputClass()} name="q" placeholder="Cari pelanggan, hewan, layanan" defaultValue={filters.search} />
      <select className={inputClass()} name="customerId" defaultValue={filters.customerId} onChange={autoSubmit}><option value="">Semua pelanggan</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select className={inputClass()} name="petId" defaultValue={filters.petId} onChange={autoSubmit}><option value="">Semua hewan</option>{petsForFilter.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <select className={inputClass()} name="status" defaultValue={filters.invoicedStatus} onChange={autoSubmit}>
        <option value="all">Semua status tagihan</option>
        <option value="unbilled">Belum tertagih</option>
        <option value="manually_billed">Tertagih manual</option>
        <option value="invoiced">Sudah invoice</option>
      </select>
      <select className={inputClass()} name="sort" defaultValue={filters.sort} onChange={autoSubmit}><option value="newest">Terbaru</option><option value="oldest">Terlama</option></select>
      <button className="h-10 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white">Terapkan</button>
    </form>

    <div className="divide-y rounded-3xl border border-slate-200 bg-white shadow-sm">
      {page.rows.length === 0 ? <p className="p-5 text-sm text-slate-500">Tidak ada kunjungan yang cocok dengan filter ini.</p> : null}
      {page.rows.map((row) => <div key={`${row.sessionSource}-${row.id}`} className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${row.sessionSource === "booking" ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800"}`}>{row.sessionSource === "booking" ? "Dari booking" : "Manual"}</span>
            <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${invoicedTone[row.invoicedStatus]}`}>{invoicedLabel[row.invoicedStatus]}</span>
            {row.invoiceNumber ? <span className="text-xs font-semibold text-slate-500">{row.invoiceNumber}</span> : null}
          </div>
          <p className="mt-1 font-bold">{row.customerName}{row.petNames.length ? ` · ${row.petNames.join(", ")}` : ""}</p>
          <p className="text-xs text-slate-500">{row.description} · {new Date(row.visitAt).toLocaleString("id-ID")} · {row.fulfillmentMode}</p>
          {row.manualBilling ? <p className="mt-1 text-xs font-semibold text-amber-700">Tertagih manual: {formatRupiah(row.manualBilling.amount)}{row.manualBilling.note ? ` — ${row.manualBilling.note}` : ""}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {row.invoicedStatus === "unbilled" ? <MarkBilledForm sourceType={row.sessionSource === "booking" ? "booking" : "manual_visit"} sourceId={row.id} /> : null}
          {row.invoicedStatus === "unbilled" && row.sessionSource === "manual" ? <CreateInvoiceFromVisitForm visitId={row.id} /> : null}
          {row.manualBilling ? <UndoBillingButton billingId={row.manualBilling.id} /> : null}
          {row.canDelete ? <DeleteVisitButton visitId={row.id} /> : null}
        </div>
      </div>)}
    </div>

    {page.hasMore && page.nextCursor ? <div className="flex justify-center">
      <a href={buildVisitHref(filters, `${encodeURIComponent(page.nextCursor.visitAt)}_${page.nextCursor.id}`)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700">Muat lebih banyak</a>
    </div> : null}
  </div>;
}
