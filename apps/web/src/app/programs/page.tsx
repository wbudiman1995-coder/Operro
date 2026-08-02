/** Customer package overview route for the HomePaw pilot. */
import { PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadCatalogWorkspace, loadCustomerWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Paket" };

export default async function ProgramsPage() {
  const workspace = await requireActiveWorkspace();
  const [catalog, customers] = await Promise.all([loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id), loadCustomerWorkspace(workspace.supabase, workspace.activeOrganization.id)]);
  const activeBalances = customers.customers.flatMap((customer) => customer.packages.map((item) => ({ customer: customer.name, ...item })));
  return <WorkspaceShell {...workspace} activePath="/programs"><PageHeader eyebrow="Retensi pelanggan" title="Paket grooming" description="Pantau produk paket dan sisa sesi pelanggan tanpa mencampur saldo dengan pembayaran." />
    <div className="mt-7 grid gap-6 lg:grid-cols-2"><section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Katalog paket</h2></div><div className="divide-y">{catalog.packages.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 p-5"><div><p className="font-bold">{item.name}</p><p className="mt-1 text-xs text-slate-500">{item.sessions} sesi · {formatRupiah(item.price)}</p></div><StatusBadge status={item.active ? "active" : "inactive"} /></div>)}</div></section><section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Saldo pelanggan</h2></div><div className="divide-y">{activeBalances.map((item, index) => <div key={`${item.customer}-${item.name}-${index}`} className="p-5"><p className="font-bold">{item.customer}</p><p className="mt-1 text-sm text-emerald-700">{item.name} · {item.remaining} sesi tersisa</p><p className="mt-1 text-xs text-slate-400">{item.expiresAt ? `Berlaku sampai ${new Date(item.expiresAt).toLocaleDateString("id-ID")}` : "Tanpa tanggal kedaluwarsa"}</p></div>)}</div></section></div>
  </WorkspaceShell>;
}
