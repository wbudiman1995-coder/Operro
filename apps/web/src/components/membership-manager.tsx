"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import {
  previewPackageReconciliationAction, renewCustomerPackageAction, repairCustomerPackageBalanceAction, setCustomerPackageStatusAction,
  type PackageReconciliationReport, type PilotActionState,
} from "@/app/pilot-actions";
import type { MembershipPackageRow, MembershipUrgency } from "@/lib/membership-admin";

const initialState: PilotActionState = { error: null, success: null };

const URGENCY_LABEL: Record<MembershipUrgency, string> = { expired: "Kedaluwarsa", urgent: "Segera berakhir", normal: "Normal", canceled: "Diarsipkan" };
const URGENCY_CLASS: Record<MembershipUrgency, string> = {
  expired: "bg-rose-50 text-rose-700", urgent: "bg-amber-50 text-amber-700", normal: "bg-emerald-50 text-emerald-700", canceled: "bg-slate-100 text-slate-500",
};

function Message({ state }: { state: PilotActionState }) {
  return state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null;
}

/** Section 25 (membership administration) + section 26 (reconciliation) for one customer_packages row. */
export function MembershipManager({ row, canManage }: { row: MembershipPackageRow; canManage: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [renewState, renewAction, renewPending] = useActionState(renewCustomerPackageAction, initialState);
  const [statusState, statusAction, statusPending] = useActionState(setCustomerPackageStatusAction, initialState);
  const [repairState, repairAction, repairPending] = useActionState(repairCustomerPackageBalanceAction, initialState);
  const [report, setReport] = useState<PackageReconciliationReport | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconciling, startReconcile] = useTransition();
  const [renewKey, setRenewKey] = useState(() => crypto.randomUUID());
  const [repairKey, setRepairKey] = useState(() => crypto.randomUUID());

  function runReconcile() {
    setReconcileError(null);
    startReconcile(async () => {
      const result = await previewPackageReconciliationAction(row.id);
      if (result.error) { setReconcileError(result.error); setReport(null); } else setReport(result.report);
    });
  }

  return <article className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/customers/${row.customerId}`} className="truncate font-bold text-slate-900 hover:underline">{row.customerName}{row.petName ? ` · ${row.petName}` : ""}</Link>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${URGENCY_CLASS[row.urgency]}`}>{URGENCY_LABEL[row.urgency]}</span>
        </div>
        <p className="mt-1 text-xs text-slate-500">{row.packageName} · {row.availableSessions}/{row.sessionsRemaining} sesi tersedia{row.reservedSessions > 0 ? ` (${row.reservedSessions} dipesan)` : ""}</p>
        <p className="mt-1 text-[11px] text-slate-400">
          Dibeli {new Date(row.purchasedAt).toLocaleDateString("id-ID")}
          {row.expiresAt ? ` · s.d. ${new Date(row.expiresAt).toLocaleDateString("id-ID")}` : " · tanpa kedaluwarsa"}
          {row.sourceInvoiceNumber ? ` · ${row.sourceInvoiceNumber}` : ""}
          {row.renewalCount > 0 ? ` · diperpanjang ${row.renewalCount}x` : ""}
        </p>
      </div>
      <button type="button" onClick={() => setExpanded((value) => !value)} className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700">{expanded ? "Tutup" : "Kelola"}</button>
    </div>

    {expanded ? <div className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-4 text-xs">
      {canManage ? <div className="flex flex-wrap gap-2">
        <form action={renewAction} onSubmit={() => setRenewKey(crypto.randomUUID())}>
          <input type="hidden" name="customerPackageId" value={row.id} />
          <input type="hidden" name="requestKey" value={renewKey} />
          <button disabled={renewPending} className="rounded-lg bg-emerald-700 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50">{renewPending ? "Memproses…" : "Perpanjang"}</button>
        </form>
        {row.status !== "canceled" ? <form action={statusAction}>
          <input type="hidden" name="customerPackageId" value={row.id} /><input type="hidden" name="status" value="canceled" /><input type="hidden" name="reason" value="Diarsipkan oleh staf" />
          <button disabled={statusPending} className="rounded-lg border border-rose-200 px-3 py-2 text-[11px] font-bold text-rose-700 disabled:opacity-50">{statusPending ? "Memproses…" : "Arsipkan"}</button>
        </form> : <form action={statusAction}>
          <input type="hidden" name="customerPackageId" value={row.id} /><input type="hidden" name="status" value="active" />
          <button disabled={statusPending} className="rounded-lg border border-emerald-200 px-3 py-2 text-[11px] font-bold text-emerald-700 disabled:opacity-50">{statusPending ? "Memproses…" : "Aktifkan lagi"}</button>
        </form>}
        <button type="button" onClick={runReconcile} disabled={reconciling} className="rounded-lg border border-indigo-200 px-3 py-2 text-[11px] font-bold text-indigo-800 disabled:opacity-50">{reconciling ? "Memeriksa…" : "Rekonsiliasi"}</button>
      </div> : null}
      <Message state={renewState} /><Message state={statusState} />
      {reconcileError ? <p className="font-semibold text-rose-700">{reconcileError}</p> : null}

      {report ? <div className="rounded-xl border border-indigo-200 bg-white p-3">
        <p className="font-bold text-slate-700">Hasil rekonsiliasi (revisi {report.revision})</p>
        <p className="mt-1">Saldo cache: <strong>{report.cachedBalance}</strong> · Saldo ledger: <strong>{report.ledgerBalance}</strong> · {report.balanceMatches ? <span className="text-emerald-700">Cocok</span> : <span className="text-rose-700">Tidak cocok</span>}</p>
        <p className="mt-1 text-slate-500">Reservasi aktif: {report.reservedCount} · Konsumsi (reservasi/ledger): {report.consumedReservations}/{report.consumptionLedgerEntries} {report.reservationConsumptionMatches ? "(cocok)" : "(tidak cocok)"}</p>
        {!report.balanceMatches && canManage ? <form action={repairAction} onSubmit={() => setRepairKey(crypto.randomUUID())} className="mt-3 flex items-center gap-2">
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
