/**
 * Function index:
 * - DashboardShell: renders the live owner dashboard inside shared application chrome.
 */
import Link from "next/link";

import { ArrowIcon, CalendarIcon } from "@/components/icons";
import { EmptyState, PageHeader, StatCard, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import type { AccessibleOrganization } from "@/lib/organizations";
import { formatRupiah, type DashboardData } from "@/lib/pilot-data";

interface DashboardShellProps {
  organizations: readonly AccessibleOrganization[];
  activeOrganization: AccessibleOrganization;
  userEmail: string;
  data: DashboardData;
}

export function DashboardShell({ organizations, activeOrganization, userEmail, data }: DashboardShellProps) {
  return <WorkspaceShell organizations={organizations} activeOrganization={activeOrganization} userEmail={userEmail} activePath="/dashboard">
    <PageHeader eyebrow={activeOrganization.status === "trial" ? "Workspace uji coba" : "Workspace aktif"} title="Ringkasan operasional" description={`Kondisi HomePaw hari ini berdasarkan data langsung di ${activeOrganization.name}.`} action={<Link href="/bookings#booking-baru" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white">+ Booking baru</Link>} />
    <section aria-label="Metrik utama" className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Booking hari ini" value={String(data.bookingToday)} helper="Tidak termasuk pembatalan dan no-show." /><StatCard label="Pendapatan hari ini" value={formatRupiah(data.revenueToday)} helper="Pembayaran berstatus berhasil." tone="success" /><StatCard label="Pelanggan aktif" value={String(data.activeCustomers)} helper="Profil pelanggan aktif di workspace." /><StatCard label="Tugas tertunda" value={String(data.openTasks)} helper="Tugas todo atau sedang berjalan." tone={data.openTasks ? "warning" : "success"} /></section>
    <div className="mt-6 grid gap-6 xl:grid-cols-[1.45fr_0.8fr]"><section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7"><div className="flex items-center justify-between gap-4"><div><h2 className="font-bold">Booking mendatang</h2><p className="mt-1 text-xs text-slate-500">Enam jadwal terdekat dalam tujuh hari</p></div><Link href="/bookings" className="text-xs font-bold text-emerald-700">Lihat jadwal</Link></div><div className="mt-5 space-y-3">{data.upcoming.length === 0 ? <EmptyState title="Belum ada booking mendatang" description="Buat booking baru atau jalankan seed demo." /> : data.upcoming.map((item) => <article key={item.id} className="flex items-center gap-4 rounded-xl bg-slate-50 p-4"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white text-emerald-700 shadow-sm"><CalendarIcon className="size-5" /></span><div className="min-w-0 flex-1"><p className="truncate font-bold">{item.customerName} · {item.petNames.join(", ") || "Hewan"}</p><p className="mt-1 text-xs text-slate-500">{new Date(item.startsAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</p></div><StatusBadge status={item.status} /></article>)}</div></section><section className="rounded-3xl bg-slate-950 p-6 text-white shadow-xl shadow-slate-950/10 sm:p-7"><p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-400">Aksi cepat</p><h2 className="mt-3 text-xl font-bold">Lanjutkan pekerjaan utama</h2><div className="mt-6 space-y-3">{[{ label: "Buat booking baru", href: "/bookings#booking-baru" }, { label: "Tambah pelanggan", href: "/customers" }, { label: "Lihat tugas", href: "/tasks" }, { label: "Buka operasional", href: "/operations" }].map((item) => <Link key={item.href} href={item.href} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-semibold text-slate-200 hover:border-emerald-400/30 hover:bg-emerald-400/10"><span>{item.label}</span><ArrowIcon className="size-4 text-emerald-400" /></Link>)}</div></section></div>
  </WorkspaceShell>;
}
