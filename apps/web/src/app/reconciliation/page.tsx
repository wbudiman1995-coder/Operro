/**
 * E2.4: operational reconciliation (read-only). Three independent checks, each shown only to callers who hold the
 * capabilities its data needs. Discrepancies are facts for a person to review; this page repairs nothing.
 */
import Link from "next/link";

import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadBranchTimezones } from "@/lib/branch-context";
import { ISSUE_COPY, loadInvoicePaymentIssues, loadUnbilledVisits, scanPayrollSources } from "@/lib/reconciliation";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { formatZonedDateTime } from "@/lib/timezone";

export const metadata = { title: "Rekonsiliasi" };

interface Query { vc?: string; ic?: string; pc?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function splitCursor(raw: string | undefined): { at: string; id: string } | null {
  if (!raw) return null;
  const separator = raw.lastIndexOf("_");
  const at = separator > 0 ? raw.slice(0, separator) : "";
  const id = separator > 0 ? raw.slice(separator + 1) : "";
  return Number.isNaN(Date.parse(at)) || !UUID.test(id) ? null : { at: new Date(at).toISOString(), id };
}
function money(value: number, currency: string) {
  try { return new Intl.NumberFormat("id-ID", { style: "currency", currency, maximumFractionDigits: currency === "IDR" ? 0 : 2 }).format(value); }
  catch { return `${currency} ${value}`; }
}

async function safe<T>(scope: string, run: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try { return { data: await run(), error: null }; }
  catch (cause) { console.error(`reconciliation_${scope}_failed`, cause); return { data: null, error: "Bagian ini belum dapat dimuat. Coba lagi." }; }
}

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<Query> }) {
  const workspace = await requireActiveWorkspace();
  const caps = workspace.capabilities;
  const canVisits = Boolean(caps["booking.read"] && caps["finance.read"]);
  const canInvoices = Boolean(caps["finance.read"]);
  const canPayroll = Boolean(caps["payroll.read"]);
  if (!canVisits && !canInvoices && !canPayroll) {
    return <WorkspaceShell {...workspace} activePath="/reconciliation"><RestrictedNotice title="Tidak ada izin rekonsiliasi" description="Rekonsiliasi memerlukan izin booking.read + finance.read, finance.read, atau payroll.read." /></WorkspaceShell>;
  }
  const query = await searchParams;
  const { defaultTimezone } = await loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id);
  const vc = splitCursor(query.vc); const ic = splitCursor(query.ic);
  const pc = query.pc && UUID.test(query.pc) ? query.pc : null;
  const [visits, invoices, payroll] = await Promise.all([
    canVisits ? safe("visits", () => loadUnbilledVisits(workspace.supabase, vc ? { visitAt: vc.at, id: vc.id } : null)) : null,
    canInvoices ? safe("invoices", () => loadInvoicePaymentIssues(workspace.supabase, ic ? { issuedAt: ic.at, id: ic.id } : null)) : null,
    canPayroll ? safe("payroll", () => scanPayrollSources(workspace.supabase, pc)) : null,
  ]);

  return <WorkspaceShell {...workspace} activePath="/reconciliation">
    <PageHeader eyebrow="Kontrol" title="Rekonsiliasi operasional" description="Tiga pemeriksaan baca-saja antara kunjungan, invoice, pembayaran, dan payroll yang sudah dipublikasikan." />
    <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">Halaman ini hanya menampilkan selisih. Tidak ada yang diperbaiki, dibuat, atau diubah otomatis, dan riwayat keuangan serta snapshot payroll tidak disentuh. Selisih dapat sah (misalnya invoice dibatalkan dengan alasan); periksa sebelum bertindak.</p>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="rec-visits">
      <h2 id="rec-visits" className="font-bold">Kunjungan selesai tanpa invoice valid</h2>
      <p className="mt-1 text-xs text-slate-500">Booking selesai atau kunjungan manual yang tidak punya invoice non-batal dan tidak ditandai ditagih manual.</p>
      {!visits ? <div className="mt-3"><RestrictedNotice title="Memerlukan izin" description="Bagian ini memerlukan booking.read dan finance.read." /></div>
        : visits.error ? <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">Pemeriksaan ini memerlukan izin booking, keuangan, dan pesanan (order.read) sekaligus; tanpa itu, kunjungan akan tampak belum ditagih secara keliru. Atau data belum dapat dimuat.</p>
        : visits.data && visits.data.rows.length === 0 ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">Tidak ada selisih pada bagian ini.</p>
        : <ul className="mt-3 divide-y divide-slate-100">{visits.data?.rows.map((row) => <li key={row.id} className="py-2 text-xs"><span className="font-bold text-slate-800">{row.customerName}</span> · {row.source === "manual" ? "Kunjungan manual" : "Booking selesai"} · {formatZonedDateTime(row.visitAt, defaultTimezone)}{row.source === "booking" ? <> · <Link href="/visits" className="text-emerald-700 underline">Daftar kunjungan</Link></> : null}</li>)}</ul>}
      {visits?.data?.hasMore && visits.data.nextCursor ? <Link href={`/reconciliation?vc=${encodeURIComponent(`${visits.data.nextCursor.visitAt}_${visits.data.nextCursor.id}`)}`} className="mt-3 inline-block text-xs font-bold text-emerald-700 underline">Muat lebih banyak</Link> : null}
    </section>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="rec-invoices">
      <h2 id="rec-invoices" className="font-bold">Invoice dan pembayaran valid</h2>
      <p className="mt-1 text-xs text-slate-500">Pembayaran valid = berstatus berhasil, dikurangi refund berhasil, dalam mata uang invoice. Mata uang tidak pernah dijumlahkan lintas mata uang.</p>
      {!invoices ? <div className="mt-3"><RestrictedNotice title="Memerlukan izin" description="Bagian ini memerlukan finance.read." /></div>
        : invoices.error ? <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">{invoices.error}</p>
        : invoices.data && invoices.data.rows.length === 0 ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">Tidak ada selisih pada bagian ini.</p>
        : <ul className="mt-3 space-y-2">{invoices.data?.rows.map((row) => <li key={row.invoiceId} className="rounded-xl border border-slate-100 p-3 text-xs">
            <p className="font-bold text-slate-800"><Link href={`/invoices/${row.invoiceId}`} className="underline">{row.invoiceNumber}</Link> · {row.customerName} · {ISSUE_COPY[row.issue].title}</p>
            <p className="mt-1 text-slate-500">{ISSUE_COPY[row.issue].detail}</p>
            <p className="mt-1 text-slate-600">Status {row.status} · total {money(row.total, row.currency)} · dibayar {money(row.paidAmount, row.currency)} · refund {money(row.refundedAmount, row.currency)} · bersih {money(row.netPaid, row.currency)}{row.foreignCurrencyPayments > 0 ? ` · ${row.foreignCurrencyPayments} pembayaran mata uang lain` : ""}</p>
          </li>)}</ul>}
      {invoices?.data?.hasMore && invoices.data.nextCursor ? <Link href={`/reconciliation?ic=${encodeURIComponent(`${invoices.data.nextCursor.issuedAt}_${invoices.data.nextCursor.id}`)}`} className="mt-3 inline-block text-xs font-bold text-emerald-700 underline">Muat lebih banyak</Link> : null}
    </section>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="rec-payroll">
      <h2 id="rec-payroll" className="font-bold">Payroll dipublikasikan dengan sumber bermasalah</h2>
      <p className="mt-1 text-xs text-slate-500">Hitungan pekerjaan di snapshot dibandingkan dengan pekerjaan valid saat ini. Pemindaian dibatasi per halaman; tombol lanjut memindai item berikutnya. Snapshot yang sudah dipublikasikan tidak pernah diubah.</p>
      {!payroll ? <div className="mt-3"><RestrictedNotice title="Memerlukan izin" description="Bagian ini memerlukan payroll.read." /></div>
        : payroll.error ? <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">{payroll.error}</p>
        : payroll.data && payroll.data.rows.length === 0 ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">Tidak ada selisih pada item yang dipindai{payroll.data.hasMore ? " (masih ada item berikutnya)" : ""}.</p>
        : <ul className="mt-3 space-y-2">{payroll.data?.rows.map((row) => <li key={row.itemId} className="rounded-xl border border-slate-100 p-3 text-xs">
            <p className="font-bold text-slate-800">{row.staffName} · {row.periodStart} s.d. {row.periodEnd} ({row.runStatus}) · {ISSUE_COPY[row.issue].title}</p>
            <p className="mt-1 text-slate-500">{ISSUE_COPY[row.issue].detail}</p>
            {row.issue === "source_reduced" ? <p className="mt-1 text-slate-600">Dasar: snapshot {row.snapshot.basic ?? "—"} / sekarang {row.live.basic ?? "—"} · Styling: {row.snapshot.styling ?? "—"} / {row.live.styling ?? "—"} · Botak: {row.snapshot.botak ?? "—"} / {row.live.botak ?? "—"}</p> : null}
          </li>)}</ul>}
      {payroll?.data?.hasMore && payroll.data.scannedThrough ? <Link href={`/reconciliation?pc=${payroll.data.scannedThrough}`} className="mt-3 inline-block text-xs font-bold text-emerald-700 underline">Pindai item berikutnya</Link> : null}
    </section>
  </WorkspaceShell>;
}
