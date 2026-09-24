/** Service and groomer configuration route for the HomePaw pilot. */
import { ResourceForm, ServiceForm } from "@/components/pilot-forms";
import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { ResourceManager } from "@/components/resource-manager";
import { ServiceManager } from "@/components/service-manager";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCatalogWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Layanan & Tim" };

export default async function CatalogPage() {
  const workspace = await requireActiveWorkspace(); const data = await loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id);
  return <WorkspaceShell {...workspace} activePath="/catalog"><PageHeader eyebrow="Konfigurasi operasional" title="Layanan & tim" description="Atur harga per ukuran hewan, durasi layanan, dan groomer yang tersedia untuk booking." />
    <div className="mt-7 grid gap-6 lg:grid-cols-2">{workspace.capabilities["service.manage"] ? <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah layanan</h2><div className="mt-5"><ServiceForm /></div></section> : null}{workspace.capabilities["resource.manage"] ? <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah groomer</h2><div className="mt-5"><ResourceForm branches={data.branches} memberships={data.memberships} /></div></section> : null}</div>
    <div className="mt-7 grid gap-6 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b p-5"><h2 className="font-bold">Daftar layanan</h2><p className="mt-1 text-xs text-slate-500">Ketuk Edit untuk mengubah harga dasar, harga per ukuran, durasi, dan mode layanan.</p></div>
        {data.services.length === 0 ? <div className="p-5"><EmptyState title="Belum ada layanan" description="Tambahkan layanan pertama menggunakan formulir di atas." /></div> : <div className="divide-y">{data.services.map((service) => <ServiceManager key={service.id} service={service} canManageService={workspace.capabilities["service.manage"]} />)}</div>}
      </section>
      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Tim groomer</h2><p className="mt-1 text-xs text-slate-500">Profil, base location, akun staf, status kalender, dan link jadwal.</p></div>{data.resources.length === 0 ? <div className="p-5"><EmptyState title="Belum ada groomer" description="Tambahkan groomer pertama menggunakan formulir di atas." /></div> : <div className="divide-y">{data.resources.map((resource) => <ResourceManager key={resource.id} resource={resource} branches={data.branches} memberships={data.memberships} canManageResource={workspace.capabilities["resource.manage"]} canManagePayroll={workspace.capabilities["payroll.manage"]} />)}</div>}</section>
    </div>
  </WorkspaceShell>;
}
