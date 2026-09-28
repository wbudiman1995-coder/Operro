/**
 * Section 29 — payment-control register UI: stage/service-month/search
 * filters, clickable stage totals, per-row confirm/validate actions, and a
 * WhatsApp shortcut. A plain SERVER component now: filtering, service-month
 * bucketing, and pagination all happen server-side (app.search_payment_register
 * / app.payment_register_stage_totals), so this file just renders the page
 * it's given — the filter bar is a native GET form and stage cards/pagination
 * are plain links, both of which cause a real navigation with new search
 * params rather than re-filtering an in-memory array. Stage totals
 * deliberately ignore the currently-selected stage filter (so you can
 * compare stage totals while narrowing by month/search) — that is an
 * intentional convention, not a bug. Confirm/validate buttons are gated on
 * the caller's OWN capability (payment.manage / payment.validate), not just
 * the row's stage: the server RPCs remain the authoritative check, this
 * only avoids showing a reader a button they cannot actually use.
 */
import { ConfirmButton, ValidateButton } from "@/components/payment-register-actions";
import { buildWhatsAppUrl } from "@/components/customer-360";
import type { PaymentRegisterPage, PaymentStage } from "@/lib/payment-register";
import { formatRupiah } from "@/lib/pilot-data";

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

interface Filters { stage: PaymentStage | "all"; month: string; search: string }

function buildHref(filters: Filters, overrides: Partial<Filters & { cursor: string }> = {}): string {
  const params = new URLSearchParams();
  const stage = overrides.stage ?? filters.stage;
  const month = overrides.month ?? filters.month;
  const search = overrides.search ?? filters.search;
  if (stage && stage !== "all") params.set("stage", stage);
  if (month) params.set("month", month);
  if (search) params.set("q", search);
  if (overrides.cursor) params.set("cursor", overrides.cursor);
  const query = params.toString();
  return query ? `/finance?${query}#kontrol-pembayaran` : "/finance#kontrol-pembayaran";
}

export function PaymentRegister({ page, filters, canManage, canValidate }: { page: PaymentRegisterPage; filters: Filters; canManage: boolean; canValidate: boolean }) {
  return <div id="kontrol-pembayaran" className="space-y-4">
    <form action="/finance" method="get" className="grid gap-3 sm:grid-cols-3">
      <input type="hidden" name="stage" value={filters.stage === "all" ? "" : filters.stage} />
      <input className="h-10 rounded-xl border border-slate-200 px-3 text-sm" name="q" placeholder="Cari invoice atau pelanggan" defaultValue={filters.search} />
      <input className="h-10 rounded-xl border border-slate-200 px-3 text-sm" type="month" name="month" defaultValue={filters.month} aria-label="Filter bulan layanan" />
      <button className="h-10 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white">Terapkan</button>
    </form>

    <div className="flex flex-wrap gap-2">
      {(Object.keys(stageLabel) as PaymentStage[]).map((stage) => {
        const totals = page.stageTotals[stage];
        const active = filters.stage === stage;
        return <a key={stage} href={buildHref(filters, { stage: active ? "all" : stage })}
          className={`rounded-xl px-3 py-2 text-left text-xs font-bold ${stageTone[stage]} ${active ? "ring-2 ring-slate-900/40" : ""}`}>
          <div>{stageLabel[stage]}</div>
          <div className="text-sm">{formatRupiah(totals.amount)} <span className="font-normal">({totals.count})</span></div>
        </a>;
      })}
    </div>

    <div className="divide-y rounded-3xl border border-slate-200 bg-white shadow-sm">
      {page.rows.length === 0 ? <p className="p-5 text-sm text-slate-500">Tidak ada pembayaran yang cocok dengan filter ini.</p> : null}
      {page.rows.map((row) => {
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

    {page.hasMore && page.nextCursor ? <div className="flex justify-center">
      <a href={buildHref(filters, { cursor: `${encodeURIComponent(page.nextCursor.paidAt)}_${page.nextCursor.id}` })} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700">Muat lebih banyak</a>
    </div> : null}
  </div>;
}
