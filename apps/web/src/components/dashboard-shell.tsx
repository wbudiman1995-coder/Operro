/**
 * Function index:
 * - DashboardShell: renders capability- and branch-scoped decision cards.
 */
import Link from "next/link";

import { ArrowIcon, CalendarIcon } from "@/components/icons";
import { DashboardSettingsForm } from "@/components/dashboard-settings-form";
import { EmptyState, PageHeader, StatCard, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import type { CapabilityMap } from "@/lib/authorization";
import { comparisonDirection, DASHBOARD_CARD_KEYS, type DashboardCardVisibility } from "@/lib/dashboard-read-model";
import type { AccessibleOrganization } from "@/lib/organizations";
import { formatRupiah, type DashboardData } from "@/lib/pilot-data";
import { formatZonedDateTime } from "@/lib/timezone";

interface DashboardShellProps {
  organizations: readonly AccessibleOrganization[];
  activeOrganization: AccessibleOrganization;
  userEmail: string;
  data: DashboardData;
  capabilities: CapabilityMap;
  dashboardCards: DashboardCardVisibility;
}

function countComparison(current: number, previous: number, unit: string): string {
  const difference = current - previous;
  const direction = comparisonDirection(current, previous);
  if (direction === "same") return `Sama dengan kemarin (${previous} ${unit}).`;
  return `${difference > 0 ? "+" : ""}${difference} dibanding kemarin (${previous} ${unit}).`;
}

function moneyComparison(current: number, previous: number): string {
  const difference = current - previous;
  const direction = comparisonDirection(current, previous);
  if (direction === "same") return `Sama dengan kemarin (${formatRupiah(previous)}).`;
  return `${difference > 0 ? "+" : "-"}${formatRupiah(Math.abs(difference))} dibanding kemarin (${formatRupiah(previous)}).`;
}

function UnavailableMetric({ label, title, description }: { label: string; title: string; description: string }) {
  return (
    <article className="rounded-[14px] border border-dashed border-slate-300 bg-slate-50 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.08em] text-slate-400">{label}</p>
      <p className="mt-3 text-sm font-bold text-slate-600">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-400">{description}</p>
    </article>
  );
}

export function DashboardShell({ organizations, activeOrganization, userEmail, data, capabilities, dashboardCards }: DashboardShellProps) {
  const quickActions = [
    capabilities["booking.create"] ? { label: "Buat booking baru", href: "/schedule?create=1" } : null,
    capabilities["customer.read"] || capabilities["customer.manage"] ? { label: "Buka pelanggan", href: "/customers" } : null,
    capabilities["finance.read"] ? { label: "Tinjau invoice & audit", href: "/finance" } : null,
    capabilities["task.manage"] ? { label: "Lihat tugas", href: "/tasks" } : null,
    capabilities["booking.read"] ? { label: "Buka operasional", href: "/operations" } : null,
  ].filter((item): item is { label: string; href: string } => item !== null);
  const anyCardVisible = DASHBOARD_CARD_KEYS.some((key) => dashboardCards[key]);

  return (
    <WorkspaceShell organizations={organizations} activeOrganization={activeOrganization} userEmail={userEmail} activePath="/dashboard" capabilities={capabilities}>
      <PageHeader
        eyebrow={activeOrganization.status === "trial" ? "Workspace uji coba" : "Workspace aktif"}
        title="Ringkasan operasional"
        description={`Kondisi bisnis hari ini berdasarkan data langsung di ${activeOrganization.name}. Periode mengikuti ${data.timeZone}.`}
        action={capabilities["booking.create"] ? <Link href="/schedule?create=1" className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-[#0f8a72] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#0b6e5a]">+ Booking baru</Link> : undefined}
      />

      {dashboardCards.revenue_today && data.revenueIncomplete ? <p role="status" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Data tagihan manual belum tersedia. Angka pendapatan dan perbandingannya hanya mencakup pembayaran berhasil yang tercatat; Operro tidak menaksir nilai yang hilang.</p> : null}

      {anyCardVisible ? <section aria-label="Metrik utama" className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {dashboardCards.booking_today ? <>
        {!capabilities["booking.read"]
          ? <UnavailableMetric label="Booking hari ini" title="Akses dibatasi" description="Peran ini tidak memiliki booking.read; nilainya tidak dimuat." />
          : !data.hasAccessibleBranch || data.bookingToday === null || data.bookingPreviousDay === null
            ? <UnavailableMetric label="Booking hari ini" title="Belum ada akses cabang" description="Tidak ada cabang yang diberikan kepada peran ini." />
          : <StatCard label="Booking hari ini" value={String(data.bookingToday)} helper={countComparison(data.bookingToday, data.bookingPreviousDay, "booking")} />}
        </> : null}
        {dashboardCards.revenue_today ? <>
        {!capabilities["finance.read"]
          ? <UnavailableMetric label="Pendapatan tercatat" title="Akses dibatasi" description="Peran ini tidak memiliki finance.read; nilainya tidak dimuat." />
          : !data.hasAccessibleBranch || data.revenueToday === null || data.revenuePreviousDay === null
            ? <UnavailableMetric label="Pendapatan tercatat" title="Belum ada akses cabang" description="Tidak ada cabang yang diberikan kepada peran ini." />
          : <StatCard label="Pendapatan tercatat" value={formatRupiah(data.revenueToday)} helper={moneyComparison(data.revenueToday, data.revenuePreviousDay)} tone="success" />}
        </> : null}
        {dashboardCards.active_customers ? <>
        {data.activeCustomers === null
          ? <UnavailableMetric label="Pelanggan aktif" title="Akses dibatasi" description="Peran ini tidak memiliki customer.read atau customer.manage; nilainya tidak dimuat." />
          : <StatCard label="Pelanggan aktif" value={String(data.activeCustomers)} helper="Profil aktif di workspace; metrik organisasi, bukan per cabang." />}
        </> : null}
        {dashboardCards.open_tasks ? <>
        {!capabilities["task.manage"]
          ? <UnavailableMetric label="Tugas tertunda" title="Akses dibatasi" description="Peran ini tidak memiliki task.manage; nilainya tidak dimuat." />
          : !data.hasAccessibleBranch || data.openTasks === null
            ? <UnavailableMetric label="Tugas tertunda" title="Belum ada akses cabang" description="Tidak ada cabang yang diberikan kepada peran ini." />
          : <StatCard label="Tugas tertunda" value={String(data.openTasks)} helper="Todo atau sedang berjalan pada cabang yang diizinkan." tone={data.openTasks ? "warning" : "success"} />}
        </> : null}
      </section> : null}

      {userEmail.toLowerCase() === "wbudiman1995@gmail.com" ? <Link href="/platform" className="mt-6 block rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">Buka panel platform Operro → organisasi, undangan, pemakaian proyek, dan permintaan kapasitas</Link> : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.45fr_0.8fr]">
        <section className="rounded-[14px] border border-[#e4e7ec] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.06)] sm:p-7">
          <div className="flex items-center justify-between gap-4">
            <div><h2 className="font-bold">Booking mendatang</h2><p className="mt-1 text-xs text-[#5b6472]">Enam jadwal terdekat dalam tujuh hari pada cabang yang diizinkan</p></div>
            {capabilities["booking.read"] ? <Link href="/schedule" className="text-xs font-bold text-[#0f8a72]">Lihat jadwal</Link> : null}
          </div>
          <div className="mt-5 space-y-3">
            {!capabilities["booking.read"]
              ? <EmptyState title="Jadwal dibatasi" description="Peran ini tidak memiliki booking.read, sehingga booking tidak dimuat." />
              : !data.hasAccessibleBranch
                ? <EmptyState title="Belum ada akses cabang" description="Berikan setidaknya satu cabang agar jadwal dapat ditampilkan." />
              : data.upcoming.length === 0
                ? <EmptyState title="Belum ada booking mendatang" description="Tidak ada booking pada cabang yang dapat diakses untuk tujuh hari ke depan." />
                : data.upcoming.map((item) => (
                  <article key={item.id} className="flex items-center gap-4 rounded-[11px] bg-[#f6f7f9] p-4">
                    <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-white text-[#0f8a72] shadow-sm"><CalendarIcon className="size-5" /></span>
                    <div className="min-w-0 flex-1"><p className="truncate font-bold">{item.customerName} · {item.petNames.join(", ") || "Hewan"}</p><p className="mt-1 text-xs text-[#5b6472]">{formatZonedDateTime(item.startsAt, data.timeZone)}</p></div>
                    <StatusBadge status={item.status} />
                  </article>
                ))}
          </div>
        </section>

        <section className="rounded-[14px] bg-[#0f1b2d] p-6 text-white shadow-xl shadow-slate-950/10 sm:p-7">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#57c9ad]">Aksi cepat</p>
          <h2 className="mt-3 text-xl font-bold">Lanjutkan pekerjaan utama</h2>
          <div className="mt-6 space-y-3">
            {quickActions.length === 0 ? <p className="rounded-[11px] border border-white/10 bg-white/5 p-4 text-sm text-slate-300">Tidak ada aksi yang tersedia untuk peran ini.</p> : quickActions.map((item) => <Link key={item.href} href={item.href} className="flex items-center justify-between rounded-[11px] border border-white/10 bg-white/5 px-4 py-4 text-sm font-semibold text-slate-200 hover:border-[#57c9ad]/30 hover:bg-[#0f8a72]/20"><span>{item.label}</span><ArrowIcon className="size-4 text-[#57c9ad]" /></Link>)}
          </div>
        </section>
      </div>
      {capabilities["settings.manage"] ? <DashboardSettingsForm key={activeOrganization.id} organizationId={activeOrganization.id} visibility={dashboardCards} /> : null}
    </WorkspaceShell>
  );
}
