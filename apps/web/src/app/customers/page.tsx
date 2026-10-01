/** Customer management route for the HomePaw pilot. */
import Link from "next/link";

import { CustomerForm } from "@/components/pilot-forms";
import { CustomerDatabase } from "@/components/customer-database";
import { FastCustomerImport } from "@/components/fast-customer-import";
import { PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCustomerWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Pelanggan" };

export default async function CustomersPage() {
  const workspace = await requireActiveWorkspace();
  const [data, boundariesResult, petTypesResult] = await Promise.all([loadCustomerWorkspace(workspace.supabase, workspace.activeOrganization.id), workspace.supabase.from("organization_dog_size_boundaries").select("xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg").eq("organization_id", workspace.activeOrganization.id).maybeSingle(), workspace.supabase.from("organization_pet_types").select("key,label,is_active").eq("organization_id", workspace.activeOrganization.id).eq("is_active", true).order("label")]);
  const incompleteLocations = data.customers.filter((customer) => customer.addresses.length === 0 || customer.addresses.every((address) => address.latitude === null || address.longitude === null)).length;

  return <WorkspaceShell {...workspace} activePath="/customers">
    <PageHeader eyebrow="CRM HomePaw" title="Pelanggan & hewan" description="Satu profil pelanggan untuk semua hewan, alamat home service, catatan grooming, dan saldo paket." action={<Link href="/customers/onboarding" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">Tinjau pendaftaran masuk</Link>} />
    <Link href="/customers/onboarding" className="mt-5 block rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"><strong>Pendaftaran dari link masuk ke sini →</strong><span className="mt-1 block text-xs">Admin atau pemilik dapat memperbaiki data, lalu menyetujui agar pelanggan dan pet masuk ke daftar ini.</span></Link>
    {incompleteLocations > 0 ? <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">{incompleteLocations} pelanggan belum memiliki alamat dengan koordinat lengkap. Lengkapi sebelum menyusun rute home service.</p> : null}
    <div className="mt-7 grid gap-5 xl:grid-cols-2"><FastCustomerImport /><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah pelanggan manual</h2><p className="mb-5 mt-1 text-xs text-slate-500">Hewan dan alamat pertama dapat langsung ditambahkan bersama profil pelanggan.</p><CustomerForm petTypes={(petTypesResult.data ?? []).map((type) => ({ key: type.key, label: type.label, active: type.is_active }))} boundaries={{ xs: Number(boundariesResult.data?.xs_lt_kg ?? 5), s: Number(boundariesResult.data?.s_lt_kg ?? 10), m: Number(boundariesResult.data?.m_lt_kg ?? 15), l: Number(boundariesResult.data?.l_lte_kg ?? 25) }} /></section></div>
    <CustomerDatabase customers={data.customers} />
  </WorkspaceShell>;
}
