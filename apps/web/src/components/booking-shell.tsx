/**
 * Function index:
 * - BookingShell: renders the weekly schedule and creation wizard in shared application chrome.
 *
 * Time zones: the week list spans every branch in the organization, and branches can run
 * different zones (WIB/WITA/WIT). Each booking is bucketed onto — and its time label is
 * rendered in — its OWN branch's zone via `groupBookingsByLocalDay`/`formatZonedTime`, never
 * the server process zone. The week boundary itself carries no branch, so it is expressed as
 * plain calendar-date strings (`weekStartISO`) resolved by the caller against the
 * organization's default-branch zone; day-card and range labels format those strings as
 * literal calendar dates (`timeZone: "UTC"` over a `T00:00:00Z` instant) so displaying them
 * never re-applies a zone conversion on top of the one already done to pick the date.
 */
import Link from "next/link";

import { BookingWizard } from "@/components/booking-wizard";
import { PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import type { BookingWorkspaceData } from "@/lib/bookings";
import type { CapabilityMap } from "@/lib/authorization";
import { groupBookingsByLocalDay } from "@/lib/booking-week";
import type { AccessibleOrganization } from "@/lib/organizations";
import { addDaysISO, formatZonedTime } from "@/lib/timezone";

interface Props { organizations: readonly AccessibleOrganization[]; activeOrganization: AccessibleOrganization; userEmail: string; capabilities: CapabilityMap; data: BookingWorkspaceData; weekStartISO: string; defaultTimezone: string; created: boolean; preselectedCustomerId?: string }

function formatDateISO(dateISO: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("id-ID", { ...options, timeZone: "UTC" }).format(new Date(`${dateISO}T00:00:00Z`));
}

export function BookingShell({ organizations, activeOrganization, userEmail, capabilities, data, weekStartISO, defaultTimezone, created, preselectedCustomerId }: Props) {
  const previousISO = addDaysISO(weekStartISO, -7);
  const nextISO = addDaysISO(weekStartISO, 7);
  const weekEndDisplayISO = addDaysISO(weekStartISO, 6);
  const branchTimezoneById = new Map(data.branches.map((branch) => [branch.id, branch.timezone]));
  const dayGroups = groupBookingsByLocalDay(data.bookings, weekStartISO, branchTimezoneById, defaultTimezone);
  return <WorkspaceShell organizations={organizations} activeOrganization={activeOrganization} userEmail={userEmail} activePath="/bookings" capabilities={capabilities}>
    <PageHeader eyebrow="Jadwal operasional" title="Booking" description="Kelola booking grooming per cabang, pelanggan, hewan, layanan, dan groomer." action={<a href="#booking-baru" className="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white">+ Booking baru</a>} />
    {created ? <p className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">Booking berhasil dibuat dan dikonfirmasi.</p> : null}
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5"><div><h2 className="font-bold">Jadwal mingguan</h2><p className="mt-1 text-xs text-slate-500">{formatDateISO(weekStartISO, { day: "numeric", month: "short" })} – {formatDateISO(weekEndDisplayISO, { day: "numeric", month: "short", year: "numeric" })}</p></div><div className="flex gap-2"><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href={`/bookings?week=${previousISO}`}>←</Link><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href="/bookings">Hari ini</Link><Link className="rounded-lg border px-3 py-2 text-sm font-semibold" href={`/bookings?week=${nextISO}`}>→</Link></div></div><div className="divide-y divide-slate-100">{dayGroups.map(({ dateISO, bookings }) => <div key={dateISO} className="grid gap-3 p-4 sm:grid-cols-[140px_1fr] sm:p-5"><div><p className="text-sm font-bold capitalize">{formatDateISO(dateISO, { weekday: "long" })}</p><p className="text-xs text-slate-500">{formatDateISO(dateISO, { day: "numeric", month: "short" })}</p></div><div className="space-y-2">{bookings.map((booking) => <article key={booking.id} className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[90px_1fr_auto] sm:items-center"><p className="text-sm font-bold text-emerald-800">{formatZonedTime(new Date(booking.startsAt), branchTimezoneById.get(booking.branchId) ?? defaultTimezone)}</p><div><p className="text-sm font-bold">{booking.customerName}</p><p className="text-xs text-slate-500">{booking.petNames.join(", ") || "Hewan belum dimuat"}</p></div><StatusBadge status={booking.status} /></article>)}{bookings.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-400">Tidak ada booking.</p> : null}</div></div>)}</div></section>
    <section id="booking-baru" className="mt-8 scroll-mt-24"><BookingWizard branches={data.branches} customers={data.customers} pets={data.pets} services={data.services} resources={data.resources} addresses={data.addresses} serviceAreas={data.serviceAreas} nextDiscounts={data.nextDiscounts} customerPackages={data.customerPackages} defaultStart={`${weekStartISO}T09:00`} preselectedCustomerId={preselectedCustomerId} /></section>
  </WorkspaceShell>;
}
