/** Service and groomer configuration route for the HomePaw pilot. */
import { ResourceForm, ServiceForm } from "@/components/pilot-forms";
import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { ResourceManager } from "@/components/resource-manager";
import { CatalogPriceMatrix } from "@/components/catalog-price-matrix";
import { DogSizeBoundariesForm } from "@/components/dog-size-boundaries-form";
import { SizeBandEditor, SizeBandModeControl, SizeBandSummary } from "@/components/size-band-editor";
import { PetTypeForm } from "@/components/pet-type-form";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCatalogWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Layanan & Tim" };

export default async function CatalogPage() {
  const workspace = await requireActiveWorkspace(); const data = await loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id);
  const dynamic = data.sizeBands.settings.mode === "dynamic";
  const [owner, boundaries] = await Promise.all([
    workspace.supabase.schema("app").rpc("is_business_owner", { p_org: workspace.activeOrganization.id }),
    workspace.supabase.from("organization_dog_size_boundaries").select("xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg").eq("organization_id", workspace.activeOrganization.id).maybeSingle(),
  ]);
  return <WorkspaceShell {...workspace} activePath="/catalog"><PageHeader eyebrow="Konfigurasi operasional" title="Layanan & tim" description="Atur harga per ukuran hewan, durasi layanan, dan groomer yang tersedia untuk booking." />
    <nav className="mt-5 flex flex-wrap gap-2 text-xs font-bold" aria-label="Bagian layanan dan tim"><a href="#batas-ukuran" className="rounded-lg border px-3 py-2">{dynamic ? "Edit kategori ukuran ↓" : "Edit batas KG XS / S / M / L / XL ↓"}</a><a href="#jenis-pet" className="rounded-lg border px-3 py-2">Jenis pet & kategori ↓</a><a href="#matriks-harga" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">Edit harga & menit per ukuran ↓</a><a href="#daftar-groomer" className="rounded-lg border px-3 py-2">Tim & akun groomer ↓</a><a href="/settings/access" className="rounded-lg border px-3 py-2">Atur akses tim →</a></nav>
    {owner.data === true ? <SizeBandModeControl mode={dynamic ? "dynamic" : "legacy"} layoutVersion={data.sizeBands.settings.layoutVersion} /> : null}
    {dynamic
      ? (owner.data === true ? <SizeBandEditor key={data.sizeBands.settings.layoutVersion} bands={data.sizeBands.bands} layoutVersion={data.sizeBands.settings.layoutVersion} /> : <SizeBandSummary bands={data.sizeBands.bands} />)
      : owner.data === true ? <DogSizeBoundariesForm initialValues={{ xs: Number(boundaries.data?.xs_lt_kg ?? 5), s: Number(boundaries.data?.s_lt_kg ?? 10), m: Number(boundaries.data?.m_lt_kg ?? 15), l: Number(boundaries.data?.l_lte_kg ?? 25) }} /> : null}
    {workspace.capabilities["service.manage"] ? <PetTypeForm petTypes={data.petTypes} /> : null}
    {workspace.capabilities["service.manage"] ? <CatalogPriceMatrix services={data.services} sizeBands={data.sizeBands} petTypes={data.petTypes} /> : null}
    <div className="mt-7 grid gap-6 lg:grid-cols-2">{workspace.capabilities["service.manage"] ? <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah baris layanan</h2><div className="mt-5"><ServiceForm petTypes={data.petTypes} sizeBands={data.sizeBands} /></div></section> : null}{workspace.capabilities["resource.manage"] ? <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah groomer</h2><div className="mt-5"><ResourceForm branches={data.branches} memberships={data.memberships} /></div></section> : null}</div>
    <div className="mt-7 grid gap-6 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b p-5"><h2 className="font-bold">Daftar layanan</h2><p className="mt-1 text-xs text-slate-500">Daftar dan pengeditan layanan sekarang dilakukan langsung melalui tabel di atas. Tambahkan baris baru memakai formulir di sebelahnya.</p></div>
        {data.services.length === 0 ? <div className="p-5"><EmptyState title="Belum ada layanan" description="Tambahkan layanan pertama menggunakan formulir di atas." /></div> : <div className="p-5 text-xs text-slate-500">{data.services.length} layanan aktif tersedia di tabel harga & durasi.</div>}
      </section>
      <section id="daftar-groomer" className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Tim groomer</h2><p className="mt-1 text-xs text-slate-500">Buat kode akses tanpa email untuk setiap groomer, lalu mereka membuka Jadwal saya untuk melihat tugas dan mengunggah foto. Groomer yang diarsipkan tetap tercatat di booking lama dan tampil terpisah di bawah.</p></div>{data.resources.filter((resource) => !resource.deletedAt).length === 0 ? <div className="p-5"><EmptyState title="Belum ada groomer aktif" description="Tambahkan groomer pertama menggunakan formulir di atas." /></div> : <div className="divide-y">{data.resources.filter((resource) => !resource.deletedAt).map((resource) => <ResourceManager key={resource.id} resource={resource} branches={data.branches} memberships={data.memberships} canManageResource={workspace.capabilities["resource.manage"]} canManagePayroll={workspace.capabilities["payroll.manage"]} />)}</div>}{data.resources.some((resource) => resource.deletedAt) ? <details className="border-t p-5"><summary className="cursor-pointer text-xs font-bold text-slate-700">Groomer diarsipkan ({data.resources.filter((resource) => resource.deletedAt).length})</summary><p className="mt-2 text-xs text-slate-500">Data dan assignment booking historis tetap tersimpan agar riwayat layanan tidak berubah.</p><div className="mt-3 divide-y rounded-xl border">{data.resources.filter((resource) => resource.deletedAt).map((resource) => <ResourceManager key={resource.id} resource={resource} branches={data.branches} memberships={data.memberships} canManageResource={false} canManagePayroll={false} />)}</div></details> : null}</section>
    </div>
  </WorkspaceShell>;
}
