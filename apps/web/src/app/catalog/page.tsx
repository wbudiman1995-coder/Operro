/** Service and groomer configuration route for the HomePaw pilot. */
import { ResourceForm, ServiceForm } from "@/components/pilot-forms";
import { PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadCatalogWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Layanan & Tim" };

export default async function CatalogPage() {
  const workspace = await requireActiveWorkspace(); const data = await loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id);
  return <WorkspaceShell {...workspace} activePath="/catalog"><PageHeader eyebrow="Konfigurasi operasional" title="Layanan & tim" description="Atur harga, durasi layanan, dan groomer yang tersedia untuk booking." />
    <div className="mt-7 grid gap-6 lg:grid-cols-2"><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah layanan</h2><div className="mt-5"><ServiceForm /></div></section><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah groomer</h2><div className="mt-5"><ResourceForm branches={data.branches} /></div></section></div>
    <div className="mt-7 grid gap-6 lg:grid-cols-2"><section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Daftar layanan</h2></div><div className="divide-y">{data.services.map((service) => <div key={service.id} className="flex items-center justify-between gap-3 p-5"><div><p className="font-bold">{service.name}</p><p className="mt-1 text-xs text-slate-500">{service.duration} menit · {formatRupiah(service.price)}</p></div><StatusBadge status={service.active ? "active" : "inactive"} /></div>)}</div></section><section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Tim groomer</h2></div><div className="divide-y">{data.resources.map((resource) => <div key={resource.id} className="flex items-center justify-between gap-3 p-5"><div><p className="font-bold">{resource.name}</p><p className="mt-1 text-xs text-slate-500">{resource.branchName}</p></div><StatusBadge status={resource.status} /></div>)}</div></section></div>
  </WorkspaceShell>;
}
