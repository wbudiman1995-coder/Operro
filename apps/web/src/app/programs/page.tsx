/** Customer package overview route for the HomePaw pilot. */
import Link from "next/link";
import { PackageForm } from "@/components/pilot-forms";
import { PackageManager } from "@/components/package-manager";
import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCatalogWorkspace, loadCustomerWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Paket" };

export default async function ProgramsPage() {
  const workspace = await requireActiveWorkspace();
  const [catalog, customers] = await Promise.all([loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id), loadCustomerWorkspace(workspace.supabase, workspace.activeOrganization.id)]);
  const activeBalances = customers.customers.flatMap((customer) => customer.packages.map((item) => ({ customer: customer.name, ...item })));
  const canManagePackages = workspace.capabilities["membership.manage"];
  const serviceOptions = catalog.services.map((service) => ({ id: service.id, name: service.name }));
  return <WorkspaceShell {...workspace} activePath="/programs"><PageHeader eyebrow="Retensi pelanggan" title="Paket grooming" description="Pantau produk paket dan sisa sesi pelanggan tanpa mencampur saldo dengan pembayaran." />
    <section className="mt-7 flex flex-col justify-between gap-4 rounded-3xl border border-amber-200 bg-amber-50 p-5 shadow-sm sm:flex-row sm:items-center sm:p-7"><div><h2 className="font-bold">Jual paket dengan invoice</h2><p className="mt-1 text-sm text-slate-600">Pilih mode Paket / prepaid. Invoice, baris paket, saldo sesi, dan jejak invoice sumber dibuat dalam satu transaksi.</p></div><Link href="/invoices/new" className="rounded-xl bg-amber-800 px-5 py-3 text-center text-sm font-bold text-white">Buat invoice paket</Link></section>
    <section className="mt-7 flex flex-col justify-between gap-4 rounded-3xl border border-indigo-200 bg-indigo-50 p-5 shadow-sm sm:flex-row sm:items-center sm:p-7"><div><h2 className="font-bold">Administrasi paket pelanggan</h2><p className="mt-1 text-sm text-slate-600">Filter berdasarkan status/urgensi, perpanjang, arsipkan, dan rekonsiliasi saldo per paket.</p></div><Link href="/programs/memberships" className="rounded-xl bg-indigo-800 px-5 py-3 text-center text-sm font-bold text-white">Buka administrasi paket</Link></section>
    {canManagePackages ? <section className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah paket katalog</h2><p className="mt-1 text-sm text-slate-500">Mengatur syarat paket untuk penjualan berikutnya. Paket yang sudah terjual ke pelanggan tidak berubah.</p><div className="mt-5"><PackageForm services={serviceOptions} /></div></section> : null}
    <div className="mt-7 grid gap-6 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b p-5"><h2 className="font-bold">Katalog paket</h2></div>
        {catalog.packages.length === 0 ? <div className="p-5"><EmptyState title="Belum ada paket" description="Tambahkan paket pertama menggunakan formulir di atas." /></div> : <div className="divide-y">{catalog.packages.map((item) => <PackageManager key={item.id} pkg={item} services={serviceOptions} canManage={canManagePackages} />)}</div>}
      </section>
      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Saldo pelanggan</h2></div><div className="divide-y">{activeBalances.map((item, index) => <div key={`${item.customer}-${item.name}-${index}`} className="p-5"><p className="font-bold">{item.customer}</p><p className="mt-1 text-sm text-emerald-700">{item.name} · {item.remaining} sesi tersisa</p><p className="mt-1 text-xs text-slate-400">{item.expiresAt ? `Berlaku sampai ${new Date(item.expiresAt).toLocaleDateString("id-ID")}` : "Tanpa tanggal kedaluwarsa"}</p></div>)}</div></section>
    </div>
  </WorkspaceShell>;
}
