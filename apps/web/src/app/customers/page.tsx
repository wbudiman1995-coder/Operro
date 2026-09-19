/** Customer management route for the HomePaw pilot. */
import Link from "next/link";

import { CustomerForm } from "@/components/pilot-forms";
import { FastCustomerImport } from "@/components/fast-customer-import";
import { EmptyState, PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadCustomerWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Pelanggan" };

export default async function CustomersPage() {
  const workspace = await requireActiveWorkspace();
  const data = await loadCustomerWorkspace(workspace.supabase, workspace.activeOrganization.id);
  const incompleteLocations = data.customers.filter((customer) => customer.addresses.length === 0 || customer.addresses.every((address) => address.latitude === null || address.longitude === null)).length;

  return <WorkspaceShell {...workspace} activePath="/customers">
    <PageHeader eyebrow="CRM HomePaw" title="Pelanggan & hewan" description="Satu profil pelanggan untuk semua hewan, alamat home service, catatan grooming, dan saldo paket." action={<Link href="/customers/onboarding" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">Link pendaftaran</Link>} />
    {incompleteLocations > 0 ? <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">{incompleteLocations} pelanggan belum memiliki alamat dengan koordinat lengkap. Lengkapi sebelum menyusun rute home service.</p> : null}
    <div className="mt-7 grid gap-5 xl:grid-cols-2"><FastCustomerImport /><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah pelanggan manual</h2><p className="mb-5 mt-1 text-xs text-slate-500">Hewan dan alamat pertama dapat langsung ditambahkan bersama profil pelanggan.</p><CustomerForm /></section></div>
    <section className="mt-7 space-y-4">
      {data.customers.length === 0 ? <EmptyState title="Belum ada pelanggan" description="Tambahkan pelanggan pertama untuk mulai menerima booking." /> : data.customers.map((customer) => {
        const address = customer.addresses.find((item) => item.isDefault) ?? customer.addresses[0];
        const coordinatesReady = address?.latitude !== null && address?.longitude !== null;
        return <article key={customer.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex flex-wrap items-center gap-2"><Link href={`/customers/${customer.id}`} className="font-bold hover:text-emerald-700">{customer.name}</Link><StatusBadge status={customer.status} />{customer.nextDiscount ? <span className="rounded-full bg-violet-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-violet-700">Diskon booking berikutnya</span> : null}</div><p className="mt-1 text-sm text-slate-500">{customer.phone ?? "Nomor belum diisi"}{customer.source ? ` · ${customer.source}` : ""}</p></div>
            <div className="flex flex-wrap gap-2"><Link href={`/customers/${customer.id}`} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700">Profil 360</Link>{customer.phone ? <a className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700" href={`https://wa.me/${customer.phone.replace(/\D/g, "").replace(/^0/, "62")}`} target="_blank" rel="noreferrer">WhatsApp</a> : null}</div>
          </div>
          {customer.nextDiscount ? <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs text-violet-900"><p className="font-bold">{customer.nextDiscount.label}</p><p className="mt-1">{Object.entries(customer.nextDiscount.rules).map(([scope, rule]) => `${scope.replaceAll("_", " ")}: ${rule.type === "percent" ? `${rule.value}%` : formatRupiah(rule.value)}`).join(" · ")}{customer.nextDiscount.expiresAt ? ` · sampai ${new Date(customer.nextDiscount.expiresAt).toLocaleDateString("id-ID")}` : ""}</p></div> : null}
          <div className={`mt-4 rounded-xl border p-3 text-xs ${address ? coordinatesReady ? "border-emerald-100 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
            {address ? <div className="flex flex-wrap items-center justify-between gap-2"><span><strong>{address.label}:</strong> {address.formattedLine}</span><span className="font-bold">{coordinatesReady ? "Koordinat siap" : "Koordinat belum ada"}</span></div> : <span className="font-bold">Alamat home service belum ditambahkan.</span>}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">{customer.pets.map((pet) => <div key={pet.id} className="rounded-xl bg-slate-50 p-4"><p className="font-bold">{pet.name}</p><p className="mt-1 text-xs text-slate-500">{pet.species} · {pet.breed ?? "Ras belum diisi"}{pet.temperament ? ` · ${pet.temperament}` : ""}</p></div>)}{customer.packages.map((item) => <div key={item.name} className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-semibold text-emerald-700">Paket aktif</p><p className="mt-1 font-bold text-emerald-950">{item.name} · {item.remaining} sesi</p></div>)}</div>
        </article>;
      })}
    </section>
  </WorkspaceShell>;
}
