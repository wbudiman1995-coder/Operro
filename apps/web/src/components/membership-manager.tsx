"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import {
  loadMembershipHistoryAction, previewPackageReconciliationAction, renewCustomerPackageAction, repairCustomerPackageBalanceAction, setCustomerPackageStatusAction,
  type MembershipHistoryEntry, type MembershipReservationEntry, type PackageReconciliationReport, type PilotActionState,
} from "@/app/pilot-actions";
import type { MembershipPackageRow, MembershipUrgency } from "@/lib/membership-admin";

const initialState: PilotActionState = { error: null, success: null };

const URGENCY_LABEL: Record<MembershipUrgency, string> = { expired: "Kedaluwarsa", urgent: "Segera berakhir", normal: "Normal", canceled: "Diarsipkan" };
const URGENCY_CLASS: Record<MembershipUrgency, string> = {
  expired: "bg-rose-50 text-rose-700", urgent: "bg-amber-50 text-amber-700", normal: "bg-emerald-50 text-emerald-700", canceled: "bg-slate-100 text-slate-500",
};
const MANUAL_REVIEW_LABEL: Record<string, string> = {
  invalid_consumption_links: "Ada sesi terpakai yang tidak tertaut ke baris ledger konsumsinya",
  invalid_reversal_links: "Ada pembatalan sesi yang tidak tertaut ke baris ledger pembaliknya",
  orphan_consumption_ledger_entries: "Ada baris ledger konsumsi tanpa reservasi terkait",
  unlinked_purchase_or_renewal_invoice: "Ada baris pembelian/perpanjangan tanpa invoice tertaut",
  missing_source_invoice: "Paket ini tidak memiliki invoice sumber (data lama)",
  over_reserved: "Jumlah sesi dipesan melebihi saldo tercatat",
  expired_but_status_active: "Sudah lewat tanggal kedaluwarsa tapi status masih aktif",
};
const REASON_LABEL: Record<string, string> = { purchase: "Pembelian", renewal: "Perpanjangan", consumption: "Konsumsi", adjustment: "Penyesuaian/pembatalan", expiry: "Kedaluwarsa", refund: "Refund" };
const RESERVATION_LABEL: Record<string, string> = { reserved: "Dipesan", consumed: "Terpakai", released: "Dilepas", expired: "Kedaluwarsa" };

const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const nextDate = (value: string, days: number) => { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return localDate(date); };

function Message({ state }: { state: PilotActionState }) {
  return state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null;
}

/** Section 25 (membership administration) + section 26 (reconciliation) for one customer_packages row. */
export function MembershipManager({ row, canManage, branches }: { row: MembershipPackageRow; canManage: boolean; branches: Array<{ id: string; name: string }> }) {
  const [expanded, setExpanded] = useState(false);
  const [report, setReport] = useState<PackageReconciliationReport | null>(null);
  const [renewKey, setRenewKey] = useState(() => crypto.randomUUID());
  const [repairKey, setRepairKey] = useState(() => crypto.randomUUID());
  const today = localDate();
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(nextDate(today, 14));
  const [renewState, renewAction, renewPending] = useActionState(async (previous: PilotActionState, formData: FormData) => {
    const result = await renewCustomerPackageAction(previous, formData);
    if (result.success) setRenewKey(crypto.randomUUID());
    return result;
  }, initialState);
  const [statusState, statusAction, statusPending] = useActionState(setCustomerPackageStatusAction, initialState);
  const [repairState, repairAction, repairPending] = useActionState(async (previous: PilotActionState, formData: FormData) => {
    const result = await repairCustomerPackageBalanceAction(previous, formData);
    if (result.success) { setRepairKey(crypto.randomUUID()); setReport(null); }
    return result;
  }, initialState);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconciling, startReconcile] = useTransition();
  const [history, setHistory] = useState<{ ledger: MembershipHistoryEntry[]; reservations: MembershipReservationEntry[] } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, startHistory] = useTransition();

  function runReconcile() {
    setReconcileError(null);
    startReconcile(async () => {
      const result = await previewPackageReconciliationAction(row.id);
      if (result.error) { setReconcileError(result.error); setReport(null); } else setReport(result.report);
    });
  }

  function loadHistory() {
    if (history) { setHistory(null); return; }
    setHistoryError(null);
    startHistory(async () => {
      const result = await loadMembershipHistoryAction(row.id);
      if (result.error) setHistoryError(result.error); else setHistory({ ledger: result.ledger, reservations: result.reservations });
    });
  }

  return <article className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/customers/${row.customerId}`} className="truncate font-bold text-slate-900 hover:underline">{row.customerName}{row.petName ? ` · ${row.petName}` : ""}</Link>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${URGENCY_CLASS[row.urgency]}`}>{URGENCY_LABEL[row.urgency]}</span>
          {row.isLegacy ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-500" title="Tidak memiliki invoice sumber tercatat">Data lama</span> : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">{row.packageName} · {row.availableSessions}/{row.sessionsRemaining} sesi tersedia{row.reservedSessions > 0 ? ` (${row.reservedSessions} dipesan)` : ""}</p>
        <p className="mt-1 text-[11px] text-slate-400">
          Dibeli {new Date(row.purchasedAt).toLocaleDateString("id-ID")}
          {row.expiresAt ? ` · s.d. ${new Date(row.expiresAt).toLocaleDateString("id-ID")}` : " · tanpa kedaluwarsa"}
          {row.sourceInvoiceNumber ? ` · ${row.sourceInvoiceNumber}` : ""}
          {row.renewalCount > 0 ? ` · diperpanjang ${row.renewalCount}x` : ""}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={loadHistory} disabled={loadingHistory} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50">{loadingHistory ? "Memuat…" : history ? "Tutup riwayat" : "Riwayat"}</button>
        <button type="button" onClick={() => setExpanded((value) => !value)} className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700">{expanded ? "Tutup" : "Kelola"}</button>
      </div>
    </div>

    {historyError ? <p className="mt-3 text-xs font-semibold text-rose-700">{historyError}</p> : null}
    {history ? <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-xs">
      <p className="font-bold text-slate-700">Riwayat ledger</p>
      {history.ledger.length === 0 ? <p className="mt-1 text-slate-500">Belum ada riwayat.</p> : <ul className="mt-2 space-y-1.5">
        {history.ledger.map((entry) => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-1.5">
          <span>{REASON_LABEL[entry.reason] ?? entry.reason} <span className={entry.delta >= 0 ? "font-bold text-emerald-700" : "font-bold text-rose-700"}>{entry.delta >= 0 ? `+${entry.delta}` : entry.delta}</span> sesi · {new Date(entry.occurredAt).toLocaleString("id-ID")}</span>
          {entry.invoiceNumber ? <Link href="/finance" className="font-semibold text-indigo-700 hover:underline">{entry.invoiceNumber}</Link> : <span className="text-slate-400">tanpa invoice</span>}
        </li>)}
      </ul>}
      <p className="mt-3 font-bold text-slate-700">Riwayat reservasi</p>
      {history.reservations.length === 0 ? <p className="mt-1 text-slate-500">Belum ada reservasi.</p> : <ul className="mt-2 space-y-1.5">
        {history.reservations.map((entry) => <li key={entry.id} className="border-b border-slate-100 pb-1.5">
          {RESERVATION_LABEL[entry.status] ?? entry.status} · dipesan {new Date(entry.reservedAt).toLocaleString("id-ID")}
          {entry.consumedAt ? ` · terpakai ${new Date(entry.consumedAt).toLocaleString("id-ID")}` : ""}
          {entry.releasedAt ? ` · dilepas ${new Date(entry.releasedAt).toLocaleString("id-ID")}` : ""}
        </li>)}
      </ul>}
    </div> : null}

    {expanded ? <div className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-4 text-xs">
      {canManage ? <div className="space-y-3">
        <form action={renewAction} className="flex flex-wrap items-end gap-2 rounded-xl border border-emerald-200 bg-white p-3">
          <input type="hidden" name="customerPackageId" value={row.id} />
          <input type="hidden" name="requestKey" value={renewKey} />
          <label className="text-[11px] font-bold text-slate-600">Cabang<select name="branchId" defaultValue={row.sourceInvoiceBranchId ?? ""} required className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs"><option value="" disabled>{row.isLegacy ? "Pilih cabang (data lama, wajib dipilih)" : "Pilih cabang"}</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
          <label className="text-[11px] font-bold text-slate-600">Tanggal invoice<input type="date" name="invoiceDate" value={invoiceDate} onChange={(event) => { setInvoiceDate(event.target.value); setDueDate(nextDate(event.target.value, 14)); }} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs" /></label>
          <label className="text-[11px] font-bold text-slate-600">Jatuh tempo<input type="date" name="dueDate" value={dueDate} min={invoiceDate} onChange={(event) => setDueDate(event.target.value)} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs" /></label>
          <button disabled={renewPending} className="h-9 rounded-lg bg-emerald-700 px-3 text-[11px] font-bold text-white disabled:opacity-50">{renewPending ? "Menerbitkan…" : "Perpanjang & terbitkan invoice"}</button>
        </form>
        <div className="flex flex-wrap gap-2">
          {row.status !== "canceled" ? <form action={statusAction}>
            <input type="hidden" name="customerPackageId" value={row.id} /><input type="hidden" name="status" value="canceled" /><input type="hidden" name="reason" value="Diarsipkan oleh staf" />
            <button disabled={statusPending} className="rounded-lg border border-rose-200 px-3 py-2 text-[11px] font-bold text-rose-700 disabled:opacity-50">{statusPending ? "Memproses…" : "Arsipkan"}</button>
          </form> : <form action={statusAction}>
            <input type="hidden" name="customerPackageId" value={row.id} /><input type="hidden" name="status" value="active" />
            <button disabled={statusPending} className="rounded-lg border border-emerald-200 px-3 py-2 text-[11px] font-bold text-emerald-700 disabled:opacity-50">{statusPending ? "Memproses…" : "Aktifkan lagi"}</button>
          </form>}
          <button type="button" onClick={runReconcile} disabled={reconciling} className="rounded-lg border border-indigo-200 px-3 py-2 text-[11px] font-bold text-indigo-800 disabled:opacity-50">{reconciling ? "Memeriksa…" : "Rekonsiliasi"}</button>
        </div>
      </div> : <button type="button" onClick={runReconcile} disabled={reconciling} className="rounded-lg border border-indigo-200 px-3 py-2 text-[11px] font-bold text-indigo-800 disabled:opacity-50">{reconciling ? "Memeriksa…" : "Rekonsiliasi"}</button>}
      <Message state={renewState} /><Message state={statusState} />
      {reconcileError ? <p className="font-semibold text-rose-700">{reconcileError}</p> : null}

      {report ? <div className="rounded-xl border border-indigo-200 bg-white p-3">
        <p className="font-bold text-slate-700">Hasil rekonsiliasi (revisi {report.revision})</p>
        <p className="mt-1">Saldo cache: <strong>{report.cachedBalance}</strong> · Saldo ledger: <strong>{report.ledgerBalance}</strong> · {report.balanceMatches ? <span className="text-emerald-700">Cocok</span> : <span className="text-rose-700">Tidak cocok</span>}</p>
        <p className="mt-1 text-slate-500">Reservasi aktif: {report.reservedCount} · Konsumsi (reservasi/ledger): {report.consumedReservations}/{report.consumptionLedgerEntries} {report.reservationConsumptionMatches ? "(cocok)" : "(tidak cocok)"}</p>
        {report.manualReviewIssues.length > 0 ? <div className="mt-2 rounded-lg bg-amber-50 p-2 text-amber-800">
          <p className="font-bold">Perlu peninjauan manual (tidak diperbaiki otomatis):</p>
          <ul className="mt-1 list-disc pl-4">{report.manualReviewIssues.map((issue) => <li key={issue}>{MANUAL_REVIEW_LABEL[issue] ?? issue}</li>)}</ul>
        </div> : null}
        {report.autoRepairable && canManage ? <form action={repairAction} className="mt-3 flex items-center gap-2">
          <input type="hidden" name="customerPackageId" value={row.id} />
          <input type="hidden" name="revision" value={report.revision} />
          <input type="hidden" name="requestKey" value={repairKey} />
          <button disabled={repairPending} className="rounded-lg bg-rose-700 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50">{repairPending ? "Memperbaiki…" : "Perbaiki saldo sekarang"}</button>
          <span className="text-[11px] text-slate-500">Aksi ini berbeda dari pratinjau: memerlukan izin membership.manage dan revisi yang masih berlaku.</span>
        </form> : null}
        <Message state={repairState} />
      </div> : null}
    </div> : null}
  </article>;
}
