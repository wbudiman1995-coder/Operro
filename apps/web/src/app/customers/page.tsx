/** Customer management route for the HomePaw pilot. */
import { CustomerForm } from "@/components/pilot-forms";
import { EmptyState, PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCustomerWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Pelanggan" };

export default async function CustomersPage() {
  const workspace = await requireActiveWorkspace();
  const data = await loadCustomerWorkspace(workspace.supabase, workspace.activeOrganization.id);
  return <WorkspaceShell {...workspace} activePath="/customers"><PageHeader eyebrow="CRM HomePaw" title="Pelanggan & hewan" description="Satu profil pelanggan untuk semua hewan, catatan grooming, dan saldo paket." />
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tambah pelanggan</h2><p className="mb-5 mt-1 text-xs text-slate-500">Hewan pertama dapat langsung ditambahkan bersama profil pelanggan.</p><CustomerForm /></section>
    <section className="mt-7 space-y-4">{data.customers.length === 0 ? <EmptyState title="Belum ada pelanggan" description="Tambahkan pelanggan pertama atau jalankan seed demo HomePaw." /> : data.customers.map((customer) => <article key={customer.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h2 className="font-bold">{customer.name}</h2><StatusBadge status={customer.status} /></div><p className="mt-1 text-sm text-slate-500">{customer.phone ?? "Nomor belum diisi"}{customer.source ? ` · ${customer.source}` : ""}</p></div>{customer.phone ? <a className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700" href={`https://wa.me/${customer.phone.replace(/\D/g, "").replace(/^0/, "62")}`} target="_blank" rel="noreferrer">Buka WhatsApp</a> : null}</div><div className="mt-4 grid gap-3 md:grid-cols-2">{customer.pets.map((pet) => <div key={pet.id} className="rounded-xl bg-slate-50 p-4"><p className="font-bold">{pet.name}</p><p className="mt-1 text-xs text-slate-500">{pet.species} · {pet.breed ?? "Ras belum diisi"}{pet.temperament ? ` · ${pet.temperament}` : ""}</p></div>)}{customer.packages.map((item) => <div key={item.name} className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-semibold text-emerald-700">Paket aktif</p><p className="mt-1 font-bold text-emerald-950">{item.name} · {item.remaining} sesi</p></div>)}</div></article>)}</section>
  </WorkspaceShell>;
}
