/** Service and groomer configuration route for the HomePaw pilot. */
import { ResourceForm, ServiceForm } from "@/components/pilot-forms";
import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { ResourceManager } from "@/components/resource-manager";
import { ServiceManager } from "@/components/service-manager";
import { HomepawServiceStarter } from "@/components/homepaw-service-starter";
import { CatalogPriceMatrix } from "@/components/catalog-price-matrix";
import { DogSizeBoundariesForm } from "@/components/dog-size-boundaries-form";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCatalogWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Layanan & Tim" };

export default async function CatalogPage() {
  const workspace = await requireActiveWorkspace(); const data = await loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id);
  const [owner, boundaries] = await Promise.all([
    workspace.supabase.schema("app").rpc("is_business_owner", { p_org: workspace.activeOrganization.id }),
    workspace.supabase.from("organization_dog_size_boundaries").select("xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg").eq("organization_id", workspace.activeOrganization.id).maybeSingle(),
  ]);
  return <WorkspaceShell {...workspace} activePath="/catalog"><PageHeader eyebrow="Konfigurasi operasional" title="Layanan & tim" description="Atur harga per ukuran hewan, durasi layanan, dan groomer yang tersedia untuk booking." />
    <nav className="mt-5 flex flex-wrap gap-2 text-xs font-bold" aria-label="Bagian layanan dan tim"><a href="#batas-ukuran" className="rounded-lg border px-3 py-2">Edit batas KG XS / S / M / L / XL ↓</a><a href="#matriks-harga" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">Edit harga & menit per ukuran ↓</a><a href="#daftar-groomer" className="rounded-lg border px-3 py-2">Tim & akun groomer ↓</a><a href="/settings/access" className="rounded-lg border px-3 py-2">Atur akses tim →</a></nav>
    {owner.data === true ? <DogSizeBoundariesForm initialValues={{ xs: Number(boundaries.data?.xs_lt_kg ?? 5), s: Number(boundaries.data?.s_lt_kg ?? 10), m: Number(boundaries.data?.m_lt_kg ?? 15), l: Number(boundaries.data?.l_lte_kg ?? 25) }} /> : null}
    {workspace.capabilities["service.manage"] ? <HomepawServiceStarter /> : null}
    {workspace.capabilities["service.manage"] ? <CatalogPriceMatrix services={data.services} /> : null}
    <div className="mt-7 grid gap-6 lg:grid-cols-2">{workspace.capabilities["service.manage"] ? <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah layanan</h2><div className="mt-5"><ServiceForm /></div></section> : null}{workspace.capabilities["resource.manage"] ? <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah groomer</h2><div className="mt-5"><ResourceForm branches={data.branches} memberships={data.memberships} /></div></section> : null}</div>
    <div className="mt-7 grid gap-6 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b p-5"><h2 className="font-bold">Daftar layanan</h2><p className="mt-1 text-xs text-slate-500">Ketuk Edit untuk mengubah harga dasar, harga per ukuran, durasi, dan mode layanan.</p></div>
        {data.services.length === 0 ? <div className="p-5"><EmptyState title="Belum ada layanan" description="Tambahkan layanan pertama menggunakan formulir di atas." /></div> : <div className="divide-y">{data.services.map((service) => <ServiceManager key={service.id} service={service} canManageService={workspace.capabilities["service.manage"]} />)}</div>}
      </section>
      <section id="daftar-groomer" className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Tim groomer</h2><p className="mt-1 text-xs text-slate-500">Undang akun groomer di Akses tim, lalu hubungkan akun ke profil di sini. Setelah masuk, groomer membuka Jadwal saya untuk melihat tugas dan mengunggah foto.</p></div>{data.resources.length === 0 ? <div className="p-5"><EmptyState title="Belum ada groomer" description="Tambahkan groomer pertama menggunakan formulir di atas." /></div> : <div className="divide-y">{data.resources.map((resource) => <ResourceManager key={resource.id} resource={resource} branches={data.branches} memberships={data.memberships} canManageResource={workspace.capabilities["resource.manage"]} canManagePayroll={workspace.capabilities["payroll.manage"]} />)}</div>}</section>
    </div>
  </WorkspaceShell>;
}
