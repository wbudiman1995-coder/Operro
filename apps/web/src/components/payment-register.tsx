"use client";

/**
 * Section 29 — payment-control register UI: stage/service-month/search
 * filters, clickable stage totals, per-row confirm/validate actions, and a
 * WhatsApp shortcut. Reads the full register (server-loaded) and filters
 * client-side. Stage totals deliberately ignore the currently-selected stage
 * filter (so you can compare stage totals while narrowing by month/search) —
 * that is an intentional convention, not a bug. Confirm/validate buttons are
 * gated on the caller's OWN capability (payment.manage / payment.validate),
 * not just the row's stage: the server RPCs remain the authoritative check,
 * this only avoids showing a reader a button they cannot actually use.
 */
import { useActionState, useMemo, useState } from "react";

import { confirmPaymentScreenshotAction, validatePaymentBankAccountAction } from "@/app/payment-actions";
import type { PaymentActionState } from "@/app/payment-actions";
import { buildWhatsAppUrl } from "@/components/customer-360";
import type { PaymentRegisterRow, PaymentStage } from "@/lib/payment-register";
import { formatRupiah } from "@/lib/pilot-data";

const initialState: PaymentActionState = { error: null, success: null };

const stageLabel: Record<PaymentStage, string> = {
  not_applicable: "Tidak perlu review",
  awaiting_screenshot: "Menunggu screenshot",
  screenshot_confirmed: "Screenshot dikonfirmasi",
  bank_validated: "Divalidasi",
  legacy_unreviewed: "Riwayat lama (belum direview)",
};

const stageTone: Record<PaymentStage, string> = {
  not_applicable: "bg-slate-100 text-slate-600",
  awaiting_screenshot: "bg-amber-100 text-amber-800",
  screenshot_confirmed: "bg-sky-100 text-sky-800",
  bank_validated: "bg-emerald-100 text-emerald-800",
  legacy_unreviewed: "bg-slate-100 text-slate-500",
};

function ConfirmButton({ paymentId }: { paymentId: string }) {
  const [state, action, pending] = useActionState(confirmPaymentScreenshotAction, initialState);
  return <form action={action} className="inline-flex flex-col items-end gap-1">
    <input type="hidden" name="paymentId" value={paymentId} />
    <button className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Konfirmasi screenshot"}</button>
    {state.error ? <p className="text-[10px] font-semibold text-rose-600">{state.error}</p> : null}
  </form>;
}

function ValidateButton({ paymentId }: { paymentId: string }) {
  const [state, action, pending] = useActionState(validatePaymentBankAccountAction, initialState);
  return <form action={action} className="inline-flex flex-col items-end gap-1">
    <input type="hidden" name="paymentId" value={paymentId} />
    <button className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Validasi rekening"}</button>
    {state.error ? <p className="text-[10px] font-semibold text-rose-600">{state.error}</p> : null}
  </form>;
}

export function PaymentRegister({ rows, canManage, canValidate }: { rows: PaymentRegisterRow[]; canManage: boolean; canValidate: boolean }) {
  const [stageFilter, setStageFilter] = useState<PaymentStage | "all">("all");
  const [monthFilter, setMonthFilter] = useState("");
  const [search, setSearch] = useState("");

  // Month/search scope, WITHOUT the stage filter — this is what totals and
  // the stage cards read from, so narrowing to one stage never changes what
  // the OTHER stage cards report.
  const scoped = useMemo(() => rows.filter((row) =>
    (!monthFilter || row.serviceMonth === monthFilter)
    && (!search.trim() || row.invoiceNumber?.toLowerCase().includes(search.trim().toLowerCase()) || row.customerName.toLowerCase().includes(search.trim().toLowerCase()))
  ), [rows, monthFilter, search]);

  const filtered = useMemo(() => scoped.filter((row) => stageFilter === "all" || row.stage === stageFilter), [scoped, stageFilter]);

  const stageTotals = useMemo(() => {
    const totals = new Map<PaymentStage, number>();
    for (const row of scoped) totals.set(row.stage, (totals.get(row.stage) ?? 0) + row.amount);
    return totals;
  }, [scoped]);

  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-3">
      <input className="h-10 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Cari invoice atau pelanggan" value={search} onChange={(e) => setSearch(e.target.value)} />
      <input className="h-10 rounded-xl border border-slate-200 px-3 text-sm" type="month" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} aria-label="Filter bulan layanan" />
      <select className="h-10 rounded-xl border border-slate-200 px-3 text-sm" value={stageFilter} onChange={(e) => setStageFilter(e.target.value as PaymentStage | "all")}>
        <option value="all">Semua tahap</option>
        {(Object.keys(stageLabel) as PaymentStage[]).map((stage) => <option key={stage} value={stage}>{stageLabel[stage]}</option>)}
      </select>
    </div>

    <div className="flex flex-wrap gap-2">
      {(Object.keys(stageLabel) as PaymentStage[]).map((stage) => (
        <button key={stage} type="button" onClick={() => setStageFilter(stageFilter === stage ? "all" : stage)}
          className={`rounded-xl px-3 py-2 text-left text-xs font-bold ${stageTone[stage]} ${stageFilter === stage ? "ring-2 ring-slate-900/40" : ""}`}>
          <div>{stageLabel[stage]}</div>
          <div className="text-sm">{formatRupiah(stageTotals.get(stage) ?? 0)}</div>
        </button>
      ))}
    </div>

    <div className="divide-y rounded-3xl border border-slate-200 bg-white shadow-sm">
      {filtered.length === 0 ? <p className="p-5 text-sm text-slate-500">Tidak ada pembayaran yang cocok dengan filter ini.</p> : null}
      {filtered.map((row) => {
        const waUrl = buildWhatsAppUrl(row.customerPhone, `Halo ${row.customerName}, terkait pembayaran invoice ${row.invoiceNumber ?? ""}.`);
        const needsProof = row.method === "bank_transfer";
        return <div key={row.id} className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="flex flex-1 flex-wrap items-start gap-4">
            {needsProof ? (
              row.proofUrl
                // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not a static asset next/image can optimize
                ? <a href={row.proofUrl} target="_blank" rel="noreferrer" className="shrink-0"><img src={row.proofUrl} alt="Bukti transfer" className="h-16 w-16 rounded-xl border border-slate-200 object-cover" /></a>
                : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-rose-300 bg-rose-50 text-center text-[9px] font-semibold text-rose-500">{row.proofAttachmentId ? "Bukti tidak dapat dibuka" : "Bukti belum ada"}</div>
            ) : null}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold">{row.invoiceNumber ?? "Tanpa invoice"}</p>
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${stageTone[row.stage]}`}>{stageLabel[row.stage]}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{row.billingMode === "package_sale" ? "Paket" : "Kunjungan"}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{row.customerName} · {row.method.replaceAll("_", " ")} · bulan layanan {row.serviceMonth}</p>
              {row.screenshotConfirmedAt ? <p className="mt-1 text-[11px] text-slate-400">Screenshot dikonfirmasi oleh {row.screenshotConfirmedBy ?? "?"} · {new Date(row.screenshotConfirmedAt).toLocaleString("id-ID")}</p> : null}
              {row.bankValidatedAt ? <p className="mt-1 text-[11px] text-slate-400">Divalidasi oleh {row.bankValidatedBy ?? "?"} · {new Date(row.bankValidatedAt).toLocaleString("id-ID")}</p> : null}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <p className="font-bold text-emerald-700">{formatRupiah(row.amount)}</p>
            {row.stage === "awaiting_screenshot" && canManage ? <ConfirmButton paymentId={row.id} /> : null}
            {row.stage === "screenshot_confirmed" && canValidate ? <ValidateButton paymentId={row.id} /> : null}
            {waUrl ? <a href={waUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-emerald-600 px-3 py-1.5 text-xs font-bold text-emerald-700">WhatsApp</a> : null}
          </div>
        </div>;
      })}
    </div>
  </div>;
}
