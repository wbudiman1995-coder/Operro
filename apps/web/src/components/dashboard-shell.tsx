/**
 * Function index:
 * - DashboardShell: renders the live owner dashboard inside shared application chrome.
 */
import Link from "next/link";

import { ArrowIcon, CalendarIcon } from "@/components/icons";
import { EmptyState, PageHeader, StatCard, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import type { CapabilityMap } from "@/lib/authorization";
import type { AccessibleOrganization } from "@/lib/organizations";
import { formatRupiah, type DashboardData } from "@/lib/pilot-data";

interface DashboardShellProps {
  organizations: readonly AccessibleOrganization[];
  activeOrganization: AccessibleOrganization;
  userEmail: string;
  data: DashboardData;
  capabilities: CapabilityMap;
}

export function DashboardShell({ organizations, activeOrganization, userEmail, data, capabilities }: DashboardShellProps) {
  return <WorkspaceShell organizations={organizations} activeOrganization={activeOrganization} userEmail={userEmail} activePath="/dashboard" capabilities={capabilities}>
    <PageHeader eyebrow={activeOrganization.status === "trial" ? "Workspace uji coba" : "Workspace aktif"} title="Ringkasan operasional" description={`Kondisi bisnis hari ini berdasarkan data langsung di ${activeOrganization.name}.`} action={<Link href="/bookings#booking-baru" className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-[#0f8a72] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#0b6e5a]">+ Booking baru</Link>} />
    <section aria-label="Metrik utama" className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Booking hari ini" value={String(data.bookingToday)} helper="Tidak termasuk pembatalan dan no-show." /><StatCard label="Pendapatan hari ini" value={formatRupiah(data.revenueToday)} helper="Pembayaran berstatus berhasil." tone="success" /><StatCard label="Pelanggan aktif" value={String(data.activeCustomers)} helper="Profil pelanggan aktif di workspace." /><StatCard label="Tugas tertunda" value={String(data.openTasks)} helper="Tugas todo atau sedang berjalan." tone={data.openTasks ? "warning" : "success"} /></section>
    <div className="mt-6 grid gap-6 xl:grid-cols-[1.45fr_0.8fr]"><section className="rounded-[14px] border border-[#e4e7ec] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.06)] sm:p-7"><div className="flex items-center justify-between gap-4"><div><h2 className="font-bold">Booking mendatang</h2><p className="mt-1 text-xs text-[#5b6472]">Enam jadwal terdekat dalam tujuh hari</p></div><Link href="/bookings" className="text-xs font-bold text-[#0f8a72]">Lihat jadwal</Link></div><div className="mt-5 space-y-3">{data.upcoming.length === 0 ? <EmptyState title="Belum ada booking mendatang" description="Buat booking baru atau jalankan seed demo." /> : data.upcoming.map((item) => <article key={item.id} className="flex items-center gap-4 rounded-[11px] bg-[#f6f7f9] p-4"><span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-white text-[#0f8a72] shadow-sm"><CalendarIcon className="size-5" /></span><div className="min-w-0 flex-1"><p className="truncate font-bold">{item.customerName} · {item.petNames.join(", ") || "Hewan"}</p><p className="mt-1 text-xs text-[#5b6472]">{new Date(item.startsAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</p></div><StatusBadge status={item.status} /></article>)}</div></section><section className="rounded-[14px] bg-[#0f1b2d] p-6 text-white shadow-xl shadow-slate-950/10 sm:p-7"><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#57c9ad]">Aksi cepat</p><h2 className="mt-3 text-xl font-bold">Lanjutkan pekerjaan utama</h2><div className="mt-6 space-y-3">{[{ label: "Buat booking baru", href: "/bookings#booking-baru" }, { label: "Tambah pelanggan", href: "/customers" }, { label: "Lihat tugas", href: "/tasks" }, { label: "Buka operasional", href: "/operations" }].map((item) => <Link key={item.href} href={item.href} className="flex items-center justify-between rounded-[11px] border border-white/10 bg-white/5 px-4 py-4 text-sm font-semibold text-slate-200 hover:border-[#57c9ad]/30 hover:bg-[#0f8a72]/20"><span>{item.label}</span><ArrowIcon className="size-4 text-[#57c9ad]" /></Link>)}</div></section></div>
  </WorkspaceShell>;
}
