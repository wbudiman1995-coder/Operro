/**
 * Function index:
 * - DashboardShell: renders the responsive owner dashboard shell and honest empty metrics.
 * - MetricCard: presents unavailable summary values without fabricating data.
 * - SidebarNav: shared desktop navigation structure for the first web milestone.
 */
import Link from "next/link";

import {
  ArrowIcon,
  CalendarIcon,
  CustomersIcon,
  DashboardIcon,
  SettingsIcon,
  TasksIcon,
} from "@/components/icons";
import { LogoutButton } from "@/components/logout-button";
import { OperroMark } from "@/components/operro-mark";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import type { AccessibleOrganization } from "@/lib/organizations";

interface DashboardShellProps {
  organizations: readonly AccessibleOrganization[];
  activeOrganization: AccessibleOrganization;
  userEmail: string;
}

const navigation = [
  { label: "Ringkasan", icon: DashboardIcon, active: true, href: "/dashboard" },
  { label: "Booking", icon: CalendarIcon, active: false, href: "/bookings" },
  { label: "Pelanggan", icon: CustomersIcon, active: false, href: null },
  { label: "Tugas", icon: TasksIcon, active: false, href: null },
];

function SidebarNav() {
  return (
    <nav aria-label="Navigasi utama" className="mt-8 space-y-1.5">
      {navigation.map((item) => {
        const Icon = item.icon;
        const className = `flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold ${
          item.active ? "bg-emerald-50 text-emerald-800" : item.href ? "text-slate-500 hover:bg-slate-50" : "text-slate-500"
        }`;
        return item.href ? (
          <Link
            key={item.label}
            href={item.href}
            aria-current={item.active ? "page" : undefined}
            className={className}
          >
            <Icon className="size-5" />
            {item.label}
          </Link>
        ) : (
          <span key={item.label} className={className}>
            <Icon className="size-5" />{item.label}
            <span className="ml-auto text-[10px] font-bold uppercase tracking-wide text-slate-300">
              Segera
            </span>
          </span>
        );
      })}
    </nav>
  );
}

function MetricCard({
  label,
  helper,
}: {
  label: string;
  helper: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-500">{label}</p>
      <div className="mt-4 flex items-end justify-between gap-4">
        <p className="text-3xl font-bold tracking-[-0.04em] text-slate-950">—</p>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
          Belum tersedia
        </span>
      </div>
      <p className="mt-4 text-xs leading-5 text-slate-400">{helper}</p>
    </article>
  );
}

export function DashboardShell({
  organizations,
  activeOrganization,
  userEmail,
}: DashboardShellProps) {
  return (
    <div className="min-h-screen bg-[#f6f8f7] text-slate-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white p-5 lg:flex lg:flex-col">
        <OperroMark />
        <SidebarNav />
        <div className="mt-auto space-y-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-900 text-xs font-bold uppercase text-white">
              {userEmail.slice(0, 1)}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-slate-400">
                Akun masuk
              </span>
              <span className="block truncate text-sm font-semibold text-slate-700">
                {userEmail}
              </span>
            </span>
          </div>
          <LogoutButton compact />
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 px-4 py-4 backdrop-blur-xl sm:px-7">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex w-full items-center justify-between sm:w-auto lg:hidden">
              <OperroMark />
              <span className="max-w-44 truncate text-xs font-semibold text-slate-400">{userEmail}</span>
            </div>
            <div className="hidden min-w-0 lg:block">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
                Workspace aktif
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-700">
                {activeOrganization.name}
              </p>
            </div>
            <div className="w-full sm:max-w-md">
              <OrganizationSwitcher
                organizations={organizations}
                activeOrganizationId={activeOrganization.id}
                variant="compact"
              />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-7 sm:px-7 sm:py-10">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-semibold text-emerald-700">
                {activeOrganization.status === "trial" ? "Workspace uji coba" : "Workspace aktif"}
              </p>
              <h1 className="mt-2 text-3xl font-bold tracking-[-0.045em] text-slate-950 sm:text-4xl">
                Ringkasan operasional
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
                Selamat datang di {activeOrganization.name}. Data ringkasan akan
                tampil setelah modul aplikasi terhubung pada milestone berikutnya.
              </p>
            </div>
            <Link
              href="/organizations"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-emerald-300 hover:text-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-500/10"
            >
              Kelola workspace
              <SettingsIcon className="size-4" />
            </Link>
          </div>

          <section aria-label="Metrik utama" className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Booking hari ini" helper="Belum ada sumber data booking yang ditampilkan." />
            <MetricCard label="Pendapatan hari ini" helper="Ringkasan finansial belum diaktifkan pada dashboard." />
            <MetricCard label="Pelanggan aktif" helper="Metrik pelanggan akan tersedia setelah integrasi modul." />
            <MetricCard label="Tugas tertunda" helper="Daftar tugas belum terhubung ke tampilan ini." />
          </section>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.45fr_0.8fr]">
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-bold text-slate-950">Booking mendatang</p>
                  <p className="mt-1 text-xs text-slate-500">Jadwal terdekat untuk workspace ini</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                  Belum terhubung
                </span>
              </div>
              <div className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-6 text-center">
                <span className="grid size-12 place-items-center rounded-2xl bg-white text-slate-400 shadow-sm">
                  <CalendarIcon className="size-6" />
                </span>
                <h2 className="mt-4 text-base font-bold text-slate-800">Belum ada data booking ditampilkan</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
                  Dashboard ini tidak menampilkan angka atau jadwal buatan. Integrasi
                  booking akan ditambahkan pada milestone aplikasi berikutnya.
                </p>
              </div>
            </section>

            <section className="rounded-3xl bg-slate-950 p-6 text-white shadow-xl shadow-slate-950/10 sm:p-7">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-400">
                Aksi cepat
              </p>
              <h2 className="mt-3 text-xl font-bold tracking-[-0.03em]">
                Mulai dari operasional yang paling penting
              </h2>
              <div className="mt-6 space-y-3">
                <Link href="/bookings#booking-baru" className="flex items-center justify-between rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-4 text-sm font-semibold text-emerald-200"><span>Buat booking baru</span><ArrowIcon className="size-4" /></Link>
                {["Tambah pelanggan", "Lihat daftar tugas"].map((label) => <div key={label} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-semibold text-slate-300"><span>{label}</span><span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Segera</span></div>)}
              </div>
              <div className="mt-6 flex items-center gap-2 text-xs leading-5 text-slate-400">
                <ArrowIcon className="size-4 shrink-0 text-emerald-400" />
                Aksi akan diaktifkan setelah alur aplikasi terkait tersedia.
              </div>
            </section>
          </div>
        </main>

        <nav
          aria-label="Navigasi seluler"
          className="fixed inset-x-4 bottom-4 z-30 grid grid-cols-4 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-2xl shadow-slate-950/10 backdrop-blur lg:hidden"
        >
          {navigation.map((item) => {
            const Icon = item.icon;
            return item.href ? (
              <Link
                key={item.label}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-semibold ${
                  item.active ? "bg-emerald-50 text-emerald-800" : "text-slate-400"
                }`}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            ) : (
              <span key={item.label} aria-disabled className="flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-semibold text-slate-400"><Icon className="size-4" />{item.label}</span>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
