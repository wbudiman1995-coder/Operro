import Link from "next/link";

import { BookingWizard } from "@/components/booking-wizard";
import { CalendarIcon, CustomersIcon, DashboardIcon, TasksIcon } from "@/components/icons";
import { LogoutButton } from "@/components/logout-button";
import { OperroMark } from "@/components/operro-mark";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import type { BookingWorkspaceData } from "@/lib/bookings";
import type { AccessibleOrganization } from "@/lib/organizations";

interface Props { organizations: readonly AccessibleOrganization[]; activeOrganization: AccessibleOrganization; userEmail: string; data: BookingWorkspaceData; weekStart: Date; created: boolean }
const navigation = [{ label: "Ringkasan", href: "/dashboard", icon: DashboardIcon }, { label: "Booking", href: "/bookings", icon: CalendarIcon }, { label: "Pelanggan", href: "#", icon: CustomersIcon }, { label: "Tugas", href: "#", icon: TasksIcon }];

export function BookingShell({ organizations, activeOrganization, userEmail, data, weekStart, created }: Props) {
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
  const previous = new Date(weekStart); previous.setDate(previous.getDate() - 7);
  const next = new Date(weekStart); next.setDate(next.getDate() + 7);
  const dayGroups = Array.from({ length: 7 }, (_, offset) => { const day = new Date(weekStart); day.setDate(day.getDate() + offset); return { day, bookings: data.bookings.filter((booking) => new Date(booking.startsAt).toDateString() === day.toDateString()) }; });
  const defaultStart = new Date(weekStart);
  defaultStart.setHours(9, 0, 0, 0);

  return <div className="min-h-screen bg-[#f6f8f7] text-slate-950">
    <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white p-5 lg:flex lg:flex-col"><OperroMark /><nav className="mt-8 space-y-1.5">{navigation.map((item) => { const Icon = item.icon; const active = item.label === "Booking"; return item.href === "#" ? <span key={item.label} className="flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold text-slate-400"><Icon className="size-5" />{item.label}<small className="ml-auto">Segera</small></span> : <Link key={item.label} href={item.href} aria-current={active ? "page" : undefined} className={`flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold ${active ? "bg-emerald-50 text-emerald-800" : "text-slate-500 hover:bg-slate-50"}`}><Icon className="size-5" />{item.label}</Link>; })}</nav><div className="mt-auto"><p className="mb-3 truncate text-xs text-slate-500">{userEmail}</p><LogoutButton compact /></div></aside>
    <div className="lg:pl-64"><header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 px-4 py-4 backdrop-blur sm:px-7"><div className="mx-auto flex max-w-7xl items-center justify-between gap-4"><div className="lg:hidden"><OperroMark /></div><div className="hidden lg:block"><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Workspace aktif</p><p className="text-sm font-semibold">{activeOrganization.name}</p></div><div className="w-full max-w-md"><OrganizationSwitcher organizations={organizations} activeOrganizationId={activeOrganization.id} variant="compact" /></div></div></header>
      <main className="mx-auto max-w-7xl px-4 py-7 pb-28 sm:px-7 sm:py-10 lg:pb-10">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold text-emerald-700">Jadwal operasional</p><h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] sm:text-4xl">Booking</h1><p className="mt-2 text-sm text-slate-500">Kelola booking grooming per cabang dan groomer.</p></div><a href="#booking-baru" className="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white">+ Booking baru</a></div>
        {created ? <p className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">Booking berhasil dibuat dan dikonfirmasi.</p> : null}
        <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5"><div><h2 className="font-bold">Jadwal mingguan</h2><p className="mt-1 text-xs text-slate-500">{weekStart.toLocaleDateString("id-ID", { day: "numeric", month: "short" })} – {new Date(weekEnd.valueOf() - 1).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}</p></div><div className="flex gap-2"><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href={`/bookings?week=${previous.toISOString().slice(0,10)}`}>←</Link><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href="/bookings">Hari ini</Link><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href={`/bookings?week=${next.toISOString().slice(0,10)}`}>→</Link></div></div>
          <div className="divide-y divide-slate-100">{dayGroups.map(({ day, bookings }) => <div key={day.toISOString()} className="grid gap-3 p-4 sm:grid-cols-[140px_1fr] sm:p-5"><div><p className="text-sm font-bold capitalize">{day.toLocaleDateString("id-ID", { weekday: "long" })}</p><p className="text-xs text-slate-500">{day.toLocaleDateString("id-ID", { day: "numeric", month: "short" })}</p></div><div className="space-y-2">{bookings.map((booking) => <article key={booking.id} className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[90px_1fr_auto] sm:items-center"><p className="text-sm font-bold text-emerald-800">{new Date(booking.startsAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</p><div><p className="text-sm font-bold">{booking.customerName}</p><p className="text-xs text-slate-500">{booking.petNames.join(", ") || "Hewan belum dimuat"}</p></div><Status status={booking.status} /></article>)}{bookings.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-400">Tidak ada booking.</p> : null}</div></div>)}</div>
        </section>
        <section id="booking-baru" className="mt-8 scroll-mt-24"><BookingWizard branches={data.branches} customers={data.customers} pets={data.pets} services={data.services} resources={data.resources} defaultStart={defaultStart.toISOString().slice(0,16)} /></section>
      </main>
      <nav className="fixed inset-x-4 bottom-4 z-30 grid grid-cols-4 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-2xl lg:hidden">{navigation.map((item) => { const Icon = item.icon; const active = item.label === "Booking"; return item.href === "#" ? <span key={item.label} className="flex flex-col items-center gap-1 p-2 text-[10px] text-slate-400"><Icon className="size-4" />{item.label}</span> : <Link key={item.label} href={item.href} className={`flex flex-col items-center gap-1 rounded-xl p-2 text-[10px] font-semibold ${active ? "bg-emerald-50 text-emerald-800" : "text-slate-500"}`}><Icon className="size-4" />{item.label}</Link>; })}</nav>
    </div>
  </div>;
}

function Status({ status }: { status: string }) { const labels: Record<string,string> = { draft:"Draft", requested:"Diminta", confirmed:"Dikonfirmasi", in_progress:"Berjalan", completed:"Selesai", canceled:"Dibatalkan", no_show:"Tidak hadir" }; return <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">{labels[status] ?? status}</span>; }
