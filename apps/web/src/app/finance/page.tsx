/** Finance route for the HomePaw pilot. */
import Link from "next/link";
import { ExpenseForm, PaymentForm } from "@/components/pilot-forms";
import { InvoiceDetailsEditor } from "@/components/invoice-details-editor";
import { PaymentRegister } from "@/components/payment-register";
import { PageHeader, StatCard, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadCatalogWorkspace, loadFinanceWorkspace } from "@/lib/pilot-data";
import { loadPaymentRegister, PAYMENT_STAGES, type PaymentStage } from "@/lib/payment-register";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Keuangan" };

function parseCursor(raw: string | undefined): { paidAt: string; id: string } | undefined {
  if (!raw) return undefined;
  const sep = raw.lastIndexOf("_");
  if (sep < 0) return undefined;
  const paidAt = decodeURIComponent(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  return paidAt && id ? { paidAt, id } : undefined;
}

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ stage?: string; month?: string; q?: string; cursor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const params = await searchParams;
  const stage = params.stage && (PAYMENT_STAGES as string[]).includes(params.stage) ? (params.stage as PaymentStage) : undefined;
  const registerFilters = { stage, serviceMonth: params.month || undefined, search: params.q || undefined, cursor: parseCursor(params.cursor) };
  const [data, catalog, paymentRegister] = await Promise.all([
    loadFinanceWorkspace(workspace.supabase, workspace.activeOrganization.id),
    loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id),
    loadPaymentRegister(workspace.supabase, workspace.activeOrganization.id, registerFilters),
  ]);
  const paid = data.payments.filter((item) => item.status === "succeeded").reduce((sum, item) => sum + item.amount, 0);
  const expense = data.expenses.reduce((sum, item) => sum + item.amount, 0);
  return <WorkspaceShell {...workspace} activePath="/finance"><PageHeader eyebrow="Kontrol kas" title="Keuangan" description="Catat pembayaran tunai, transfer, QRIS sebagai metode lain, serta pengeluaran operasional." action={<Link href="/invoices/new" className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white">Buat invoice</Link>} />
    <div className="mt-7 grid gap-4 sm:grid-cols-3"><StatCard label="Pembayaran tercatat" value={formatRupiah(paid)} helper="Seluruh pembayaran berhasil yang dimuat." tone="success" /><StatCard label="Pengeluaran" value={formatRupiah(expense)} helper="Pengeluaran operasional yang dimuat." tone="warning" /><StatCard label="Invoice belum lunas" value={String(data.invoices.filter((item) => item.status === "issued").length)} helper="Perlu ditagih atau direkonsiliasi." /></div>
    <div className="mt-7 grid gap-6 lg:grid-cols-2"><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Catat pembayaran</h2><div className="mt-5"><PaymentForm invoices={data.invoices.filter((item) => item.status === "issued")} /></div></section><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Catat pengeluaran</h2><div className="mt-5"><ExpenseForm branches={catalog.branches} /></div></section></div>
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Invoice</h2></div><div className="divide-y">{data.invoices.map((invoice) => <div key={invoice.id} className="p-5"><div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><Link href={`/invoices/${invoice.id}`} className="font-bold underline-offset-2 hover:underline">{invoice.number}</Link><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${invoice.billingMode === "package_sale" ? "bg-amber-100 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>{invoice.billingMode === "package_sale" ? "Paket" : invoice.documentType === "service_report" ? "Laporan prepaid" : "Kunjungan"}</span></div><p className="mt-1 text-xs text-slate-500">{invoice.customerName} · {new Date(invoice.issuedAt).toLocaleDateString("id-ID")}{invoice.dueAt ? ` · jatuh tempo ${new Date(invoice.dueAt).toLocaleDateString("id-ID")}` : ""}</p>{invoice.groomerName ? <p className="mt-1 text-xs font-semibold text-slate-600">Groomer: {invoice.groomerName}</p> : null}</div><div className="text-right"><p className="font-bold">{formatRupiah(invoice.total)}</p><StatusBadge status={invoice.status} /></div></div>{invoice.canEdit ? <InvoiceDetailsEditor invoice={invoice} groomers={catalog.resources} /> : invoice.status !== "issued" ? <p className="mt-3 text-xs font-semibold text-slate-400">Invoice final dikunci.</p> : <p className="mt-3 text-xs font-semibold text-slate-400">Detail dikunci karena pembayaran sudah tercatat.</p>}</div>)}</div></section>

    <section className="mt-7">
      <h2 className="mb-4 font-bold">Kontrol pembayaran</h2>
      <PaymentRegister page={paymentRegister} filters={{ stage: stage ?? "all", month: params.month ?? "", search: params.q ?? "" }} canManage={workspace.capabilities["payment.manage"]} canValidate={workspace.capabilities["payment.validate"]} />
    </section>
  </WorkspaceShell>;
}
