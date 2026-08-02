/**
 * Function index:
 * - BookingShell: renders the weekly schedule and creation wizard in shared application chrome.
 */
import Link from "next/link";

import { BookingWizard } from "@/components/booking-wizard";
import { PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import type { BookingWorkspaceData } from "@/lib/bookings";
import type { AccessibleOrganization } from "@/lib/organizations";

interface Props { organizations: readonly AccessibleOrganization[]; activeOrganization: AccessibleOrganization; userEmail: string; data: BookingWorkspaceData; weekStart: Date; created: boolean }

export function BookingShell({ organizations, activeOrganization, userEmail, data, weekStart, created }: Props) {
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
  const previous = new Date(weekStart); previous.setDate(previous.getDate() - 7);
  const next = new Date(weekStart); next.setDate(next.getDate() + 7);
  const dayGroups = Array.from({ length: 7 }, (_, offset) => { const day = new Date(weekStart); day.setDate(day.getDate() + offset); return { day, bookings: data.bookings.filter((booking) => new Date(booking.startsAt).toDateString() === day.toDateString()) }; });
  const defaultStart = new Date(weekStart); defaultStart.setHours(9, 0, 0, 0);
  return <WorkspaceShell organizations={organizations} activeOrganization={activeOrganization} userEmail={userEmail} activePath="/bookings">
    <PageHeader eyebrow="Jadwal operasional" title="Booking" description="Kelola booking grooming per cabang, pelanggan, hewan, layanan, dan groomer." action={<a href="#booking-baru" className="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white">+ Booking baru</a>} />
    {created ? <p className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">Booking berhasil dibuat dan dikonfirmasi.</p> : null}
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5"><div><h2 className="font-bold">Jadwal mingguan</h2><p className="mt-1 text-xs text-slate-500">{weekStart.toLocaleDateString("id-ID", { day: "numeric", month: "short" })} – {new Date(weekEnd.valueOf() - 1).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}</p></div><div className="flex gap-2"><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href={`/bookings?week=${previous.toISOString().slice(0,10)}`}>←</Link><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href="/bookings">Hari ini</Link><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href={`/bookings?week=${next.toISOString().slice(0,10)}`}>→</Link></div></div><div className="divide-y divide-slate-100">{dayGroups.map(({ day, bookings }) => <div key={day.toISOString()} className="grid gap-3 p-4 sm:grid-cols-[140px_1fr] sm:p-5"><div><p className="text-sm font-bold capitalize">{day.toLocaleDateString("id-ID", { weekday: "long" })}</p><p className="text-xs text-slate-500">{day.toLocaleDateString("id-ID", { day: "numeric", month: "short" })}</p></div><div className="space-y-2">{bookings.map((booking) => <article key={booking.id} className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[90px_1fr_auto] sm:items-center"><p className="text-sm font-bold text-emerald-800">{new Date(booking.startsAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</p><div><p className="text-sm font-bold">{booking.customerName}</p><p className="text-xs text-slate-500">{booking.petNames.join(", ") || "Hewan belum dimuat"}</p></div><StatusBadge status={booking.status} /></article>)}{bookings.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-400">Tidak ada booking.</p> : null}</div></div>)}</div></section>
    <section id="booking-baru" className="mt-8 scroll-mt-24"><BookingWizard branches={data.branches} customers={data.customers} pets={data.pets} services={data.services} resources={data.resources} defaultStart={defaultStart.toISOString().slice(0,16)} /></section>
  </WorkspaceShell>;
}
