/** Finance route for the HomePaw pilot. */
import { ExpenseForm, PaymentForm } from "@/components/pilot-forms";
import { PageHeader, StatCard, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadCatalogWorkspace, loadFinanceWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Keuangan" };

export default async function FinancePage() {
  const workspace = await requireActiveWorkspace();
  const [data, catalog] = await Promise.all([loadFinanceWorkspace(workspace.supabase, workspace.activeOrganization.id), loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id)]);
  const paid = data.payments.filter((item) => item.status === "succeeded").reduce((sum, item) => sum + item.amount, 0);
  const expense = data.expenses.reduce((sum, item) => sum + item.amount, 0);
  return <WorkspaceShell {...workspace} activePath="/finance"><PageHeader eyebrow="Kontrol kas" title="Keuangan" description="Catat pembayaran tunai, transfer, QRIS sebagai metode lain, serta pengeluaran operasional." />
    <div className="mt-7 grid gap-4 sm:grid-cols-3"><StatCard label="Pembayaran tercatat" value={formatRupiah(paid)} helper="Seluruh pembayaran berhasil yang dimuat." tone="success" /><StatCard label="Pengeluaran" value={formatRupiah(expense)} helper="Pengeluaran operasional yang dimuat." tone="warning" /><StatCard label="Invoice belum lunas" value={String(data.invoices.filter((item) => item.status === "issued").length)} helper="Perlu ditagih atau direkonsiliasi." /></div>
    <div className="mt-7 grid gap-6 lg:grid-cols-2"><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Catat pembayaran</h2><div className="mt-5"><PaymentForm invoices={data.invoices.filter((item) => item.status === "issued")} /></div></section><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Catat pengeluaran</h2><div className="mt-5"><ExpenseForm branches={catalog.branches} /></div></section></div>
    <div className="mt-7 grid gap-6 xl:grid-cols-2"><section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Invoice</h2></div><div className="divide-y">{data.invoices.map((invoice) => <div key={invoice.id} className="flex items-center justify-between gap-4 p-5"><div><p className="font-bold">{invoice.number}</p><p className="mt-1 text-xs text-slate-500">{invoice.customerName} · {new Date(invoice.issuedAt).toLocaleDateString("id-ID")}</p></div><div className="text-right"><p className="font-bold">{formatRupiah(invoice.total)}</p><StatusBadge status={invoice.status} /></div></div>)}</div></section><section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Pembayaran terakhir</h2></div><div className="divide-y">{data.payments.map((payment) => <div key={payment.id} className="flex items-center justify-between gap-4 p-5"><div><p className="font-bold capitalize">{payment.method.replaceAll("_", " ")}</p><p className="mt-1 text-xs text-slate-500">{new Date(payment.paidAt).toLocaleString("id-ID")}</p></div><p className="font-bold text-emerald-700">{formatRupiah(payment.amount)}</p></div>)}</div></section></div>
  </WorkspaceShell>;
}
