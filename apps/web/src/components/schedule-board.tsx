"use client";

/**
 * Function index:
 * - ScheduleBoard: dispatcher calendar with day/3-day/week views, filters, and detail drawer.
 * - DayResourceGrid: day view — one column per groomer, absolute time positioning.
 * - MultiDayCalendar: 3-day and week views — one time grid column per day.
 * - BookingDrawer: read-only booking detail as a right drawer on desktop, sheet on mobile.
 *
 * View design note: the day view is the true dispatch board (columns = groomers). The
 * 3-day and week views use day columns instead, because groomers × 7 days is unusable at
 * any realistic width. This is a deliberate departure from the HomePaw grid.
 *
 * Calendar mutations stay behind the explicit reschedule/cancel forms and the database
 * exclusion constraint. The visual board never writes booking rows directly.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";

import { BlackoutManager } from "@/components/blackout-manager";
import { BookingCancelForm, BookingEditForm, BookingSeriesForm } from "@/components/booking-edit-form";
import { StatusBadge } from "@/components/pilot-ui";
import { WeeklyAvailabilityManager } from "@/components/weekly-availability-manager";
import { isCancellable, isReschedulable } from "@/lib/booking-mutations";
import { SCHEDULE_ROW_LIMIT, type BookingDetail, type ScheduleWorkspace } from "@/lib/schedule";
import {
  SCHEDULE_VIEWS,
  SCHEDULE_VIEW_LABELS,
  type ScheduleView,
  minutesToLabel,
  positionWithin,
  resolveMinuteBounds,
  slotMarkers,
} from "@/lib/schedule-layout";
import { addDaysISO } from "@/lib/timezone";

interface ScheduleBoardProps {
  data: ScheduleWorkspace;
  view: ScheduleView;
  anchorISO: string;
  todayISO: string;
  detail: BookingDetail | null;
  /** Resolved from app.has_permission, never hard-coded. */
  canReadFinance: boolean;
  canUpdateBooking: boolean;
  canCancelBooking: boolean;
  canManageResources: boolean;
}

function dayHeading(dayISO: string) {
  const [year, month, day] = dayISO.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

export function ScheduleBoard({ data, view, anchorISO, todayISO, detail, canReadFinance, canUpdateBooking, canCancelBooking, canManageResources }: ScheduleBoardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [drawerOpen, setDrawerOpen] = useState(detail !== null);

  const pushParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      startTransition(() => router.push(`${pathname}?${params.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams],
  );

  const stepDays = view === "day" ? 1 : view === "3day" ? 3 : 7;

  // Groomer, blackout and row-limit filtering all happen in the query now, so
  // everything reaching this component is already the visible set.
  const visibleBookings = data.bookings;
  const selectedResourceIds = data.appliedResourceIds;

  // Bounds are derived from the same filtered segments that render, so a hidden
  // groomer's early or late work no longer stretches the visible time axis.
  const bounds = useMemo(
    () =>
      resolveMinuteBounds(
        [...visibleBookings, ...data.blackouts].flatMap((entry) => entry.segments),
        data.activeBranch.dayStartMinutes,
        data.activeBranch.dayEndMinutes,
      ),
    [visibleBookings, data.blackouts, data.activeBranch.dayStartMinutes, data.activeBranch.dayEndMinutes],
  );

  function openBooking(bookingId: string) {
    setDrawerOpen(true);
    pushParams((params) => params.set("booking", bookingId));
  }

  function closeDrawer() {
    setDrawerOpen(false);
    pushParams((params) => params.delete("booking"));
  }

  return (
    <div className="mt-7">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Periode sebelumnya" onClick={() => pushParams((p) => p.set("date", addDaysISO(anchorISO, -stepDays)))} className="grid size-9 place-items-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50">‹</button>
            <button type="button" onClick={() => pushParams((p) => p.set("date", todayISO))} className="h-9 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600 transition hover:bg-slate-50">Hari ini</button>
            <button type="button" aria-label="Periode berikutnya" onClick={() => pushParams((p) => p.set("date", addDaysISO(anchorISO, stepDays)))} className="grid size-9 place-items-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50">›</button>
          </div>

          <div role="group" aria-label="Tampilan kalender" className="flex rounded-xl border border-slate-200 p-0.5">
            {SCHEDULE_VIEWS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => pushParams((p) => p.set("view", option))}
                className={`h-8 rounded-lg px-3 text-xs font-bold transition ${view === option ? "bg-emerald-50 text-emerald-800" : "text-slate-400 hover:text-slate-600"}`}
              >
                {SCHEDULE_VIEW_LABELS[option]}
              </button>
            ))}
          </div>

          {data.branches.length > 1 ? (
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
              <span className="sr-only">Cabang</span>
              <select
                value={data.activeBranch.id}
                onChange={(event) => pushParams((p) => { p.set("branch", event.target.value); p.delete("groomer"); p.delete("booking"); })}
                className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700"
              >
                {data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </label>
          ) : null}

          <span aria-live="polite" className="ml-auto text-xs font-semibold text-slate-400">
            {pending ? "Memuat…" : `${visibleBookings.length} booking · ${data.activeBranch.timezone}`}
          </span>
          <button
            type="button"
            onClick={() => startTransition(() => router.refresh())}
            disabled={pending}
            className="h-9 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {pending ? "Memuat…" : "Segarkan"}
          </button>
        </div>

        {data.branchResources.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Groomer</span>
            <button
              type="button"
              aria-pressed={selectedResourceIds.length === 0}
              onClick={() => pushParams((p) => p.delete("groomer"))}
              className={`h-7 rounded-lg px-2.5 text-xs font-bold transition ${selectedResourceIds.length === 0 ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
            >
              Semua
            </button>
            {data.branchResources.map((resource) => {
              const active = selectedResourceIds.includes(resource.id);
              return (
                <button
                  key={resource.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    pushParams((p) => {
                      const next = active ? selectedResourceIds.filter((id) => id !== resource.id) : [...selectedResourceIds, resource.id];
                      p.delete("groomer");
                      for (const id of next) p.append("groomer", id);
                    })
                  }
                  className={`h-7 rounded-lg px-2.5 text-xs font-bold transition ${active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
                >
                  {resource.name}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {data.truncated ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
          Periode ini melebihi {SCHEDULE_ROW_LIMIT} booking dan sebagian tidak ditampilkan. Persempit rentang tanggal atau pilih groomer tertentu — keduanya diterapkan pada kueri, sehingga baris yang tersembunyi akan muncul kembali.
        </p>
      ) : null}

      {data.branchResources.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-12 text-center">
          <p className="font-bold text-slate-700">Belum ada groomer aktif di cabang ini</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">Tambahkan sumber daya bertipe staf pada menu Layanan &amp; tim agar kalender dapat menampilkan kolom groomer.</p>
        </div>
      ) : view === "day" ? (
        <DayResourceGrid data={data} bookings={visibleBookings} bounds={bounds} dayISO={data.days[0]} onOpen={openBooking} activeBookingId={detail?.id ?? null} />
      ) : (
        <MultiDayCalendar data={data} bookings={visibleBookings} bounds={bounds} todayISO={todayISO} onOpen={openBooking} activeBookingId={detail?.id ?? null} />
      )}

      {canManageResources ? (
        <>
          <WeeklyAvailabilityManager resources={data.branchResources} availability={data.weeklyAvailability} timeZone={data.activeBranch.timezone} />
          <BlackoutManager branchId={data.activeBranch.id} timeZone={data.activeBranch.timezone} resources={data.branchResources} blackouts={data.blackouts} defaultDateISO={data.days[0]} />
        </>
      ) : null}

      {detail && drawerOpen ? (
        <BookingDrawer
          detail={detail}
          onClose={closeDrawer}
          canReadFinance={canReadFinance}
          canUpdateBooking={canUpdateBooking}
          canCancelBooking={canCancelBooking}
          branchResources={data.branchResources}
          timeZone={data.activeBranch.timezone}
        />
      ) : null}
    </div>
  );
}

function DayResourceGrid({
  data,
  bookings,
  bounds,
  dayISO,
  onOpen,
  activeBookingId,
}: {
  data: ScheduleWorkspace;
  bookings: ScheduleWorkspace["bookings"];
  bounds: { startMinutes: number; endMinutes: number };
  dayISO: string;
  onOpen: (id: string) => void;
  activeBookingId: string | null;
}) {
  const markers = slotMarkers(bounds);
  const gridHeight = Math.max(((bounds.endMinutes - bounds.startMinutes) / 30) * 34, 320);
  // One entry per booking-day segment, so a booking spanning local midnight appears on
  // every day it occupies instead of only the day holding its start.
  const dayEntries = bookings.flatMap((booking) =>
    booking.segments.filter((segment) => segment.dayISO === dayISO).map((segment) => ({ booking, segment })),
  );

  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="min-w-[640px]">
        <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="w-16 shrink-0 border-r border-slate-100 px-2 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Jam</div>
          {data.resources.map((resource) => (
            <div key={resource.id} className="flex-1 border-r border-slate-100 px-3 py-3 last:border-r-0">
              <p className="truncate text-sm font-bold text-slate-700">{resource.name}</p>
              <p className="text-[11px] text-slate-400">{dayEntries.filter((entry) => entry.booking.resourceIds.includes(resource.id)).length} booking</p>
            </div>
          ))}
        </div>

        <div className="flex" style={{ height: gridHeight }}>
          <div className="relative w-16 shrink-0 border-r border-slate-100">
            {markers.map((minute) => (
              <span
                key={minute}
                className="absolute left-0 w-full -translate-y-1/2 px-2 text-right text-[10px] font-semibold text-slate-300"
                style={{ top: `${((minute - bounds.startMinutes) / (bounds.endMinutes - bounds.startMinutes)) * 100}%` }}
              >
                {minutesToLabel(minute)}
              </span>
            ))}
          </div>

          {data.resources.map((resource) => (
            <div key={resource.id} className="relative flex-1 border-r border-slate-100 last:border-r-0">
              {markers.map((minute) => (
                <span
                  key={minute}
                  aria-hidden
                  className="absolute inset-x-0 border-t border-slate-100"
                  style={{ top: `${((minute - bounds.startMinutes) / (bounds.endMinutes - bounds.startMinutes)) * 100}%` }}
                />
              ))}

              {data.blackouts
                .filter((blackout) => blackout.resourceId === resource.id)
                .flatMap((blackout) => blackout.segments.filter((segment) => segment.dayISO === dayISO).map((segment) => ({ blackout, segment })))
                .map(({ blackout, segment }) => {
                  const position = positionWithin(segment, bounds);
                  if (!position) return null;
                  return (
                    <div
                      key={`${blackout.id}:${segment.dayISO}`}
                      title={blackout.reason ? `Tidak tersedia — ${blackout.reason}` : "Tidak tersedia"}
                      className="absolute inset-x-1 rounded-lg border border-slate-200 bg-[repeating-linear-gradient(45deg,#f1f5f9_0,#f1f5f9_6px,#e2e8f0_6px,#e2e8f0_12px)] px-2 py-1"
                      style={{ top: `${position.topPercent}%`, height: `${position.heightPercent}%` }}
                    >
                      <p className="truncate text-[10px] font-bold text-slate-500">Tidak tersedia</p>
                      {blackout.reason ? <p className="truncate text-[10px] text-slate-400">{blackout.reason}</p> : null}
                    </div>
                  );
                })}

              {dayEntries
                .filter((entry) => entry.booking.resourceIds.includes(resource.id))
                .map(({ booking, segment }) => {
                  const position = positionWithin(segment, bounds);
                  if (!position) return null;
                  const active = booking.id === activeBookingId;
                  return (
                    <button
                      key={`${booking.id}:${segment.dayISO}`}
                      type="button"
                      onClick={() => onOpen(booking.id)}
                      style={{ top: `${position.topPercent}%`, height: `${position.heightPercent}%` }}
                      className={`absolute inset-x-1 overflow-hidden rounded-lg border px-2 py-1 text-left transition ${active ? "border-emerald-500 bg-emerald-100" : booking.status === "canceled" || booking.status === "no_show" ? "border-slate-200 bg-slate-50 opacity-70" : "border-emerald-200 bg-emerald-50 hover:border-emerald-400"}`}
                    >
                      <p className="truncate text-[11px] font-bold text-emerald-900">
                        {segment.continuesBefore ? "◂ " : ""}{booking.startLabel} {booking.customerName}{segment.continuesAfter ? " ▸" : ""}
                      </p>
                      <p className="truncate text-[10px] text-emerald-700">{booking.pets.map((pet) => pet.petName).join(", ") || "Tanpa hewan"}</p>
                      <BookingBadges booking={booking} compact />
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BookingBadges({ booking, compact = false }: { booking: ScheduleWorkspace["bookings"][number]; compact?: boolean }) {
  const mode = booking.fulfillmentMode === "home" ? "Home" : booking.fulfillmentMode === "pickup_delivery" ? "Antar-jemput" : "Toko";
  const modeClass = booking.fulfillmentMode === "home" ? "bg-blue-100 text-blue-700" : booking.fulfillmentMode === "pickup_delivery" ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600";
  return (
    <span className={`mt-1 flex flex-wrap items-center gap-1 ${compact ? "max-h-4 overflow-hidden" : ""}`}>
      <span className={`rounded px-1 py-0.5 text-[9px] font-extrabold ${modeClass}`}>{mode}</span>
      {booking.dispatchStage ? <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-extrabold text-amber-700">{booking.dispatchStage.replaceAll("_", " ")}</span> : null}
      {booking.travelMinutes ? <span className="rounded bg-cyan-50 px-1 py-0.5 text-[9px] font-bold text-cyan-700">{booking.travelMinutes} mnt jalan</span> : null}
      {booking.serviceAreaMatched === false ? <span className="rounded bg-rose-100 px-1 py-0.5 text-[9px] font-extrabold text-rose-700">Di luar area</span> : null}
    </span>
  );
}

function MultiDayCalendar({
  data,
  bookings,
  bounds,
  todayISO,
  onOpen,
  activeBookingId,
}: {
  data: ScheduleWorkspace;
  bookings: ScheduleWorkspace["bookings"];
  bounds: { startMinutes: number; endMinutes: number };
  todayISO: string;
  onOpen: (id: string) => void;
  activeBookingId: string | null;
}) {
  const resourceNames = new Map(data.resources.map((resource) => [resource.id, resource.name]));
  const markers = slotMarkers(bounds);
  const gridHeight = Math.max(((bounds.endMinutes - bounds.startMinutes) / 30) * 34, 420);
  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div style={{ minWidth: `${Math.max(720, data.days.length * 180 + 64)}px` }}>
        <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="w-16 shrink-0 border-r border-slate-100 px-2 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Jam</div>
          {data.days.map((dayISO) => {
            const count = bookings.filter((booking) => booking.segments.some((segment) => segment.dayISO === dayISO)).length;
            return (
              <div key={dayISO} className={`min-w-0 flex-1 border-r border-slate-100 px-3 py-3 last:border-r-0 ${dayISO === todayISO ? "bg-emerald-50/70" : ""}`}>
                <p className={`text-sm font-bold ${dayISO === todayISO ? "text-emerald-800" : "text-slate-700"}`}>{dayHeading(dayISO)}</p>
                <p className="text-[11px] text-slate-400">{count} booking</p>
              </div>
            );
          })}
        </div>
        <div className="flex" style={{ height: gridHeight }}>
          <div className="relative w-16 shrink-0 border-r border-slate-100">
            {markers.map((minute) => (
              <span key={minute} className="absolute left-0 w-full -translate-y-1/2 px-2 text-right text-[10px] font-semibold text-slate-300" style={{ top: `${((minute - bounds.startMinutes) / (bounds.endMinutes - bounds.startMinutes)) * 100}%` }}>{minutesToLabel(minute)}</span>
            ))}
          </div>
          {data.days.map((dayISO) => {
        const dayBookings = bookings
          .flatMap((booking) => booking.segments.filter((segment) => segment.dayISO === dayISO).map((segment) => ({ booking, segment })))
          .sort((a, b) => a.segment.startMinutes - b.segment.startMinutes);
        const dayBlackouts = data.blackouts.flatMap((blackout) =>
          blackout.segments.filter((segment) => segment.dayISO === dayISO).map((segment) => ({ blackout, segment })),
        );
        return (
          <section key={dayISO} className={`relative min-w-0 flex-1 border-r border-slate-100 last:border-r-0 ${dayISO === todayISO ? "bg-emerald-50/20" : ""}`}>
              {markers.map((minute) => <span key={minute} aria-hidden className="absolute inset-x-0 border-t border-slate-100" style={{ top: `${((minute - bounds.startMinutes) / (bounds.endMinutes - bounds.startMinutes)) * 100}%` }} />)}
              {dayBookings.map(({ booking, segment }) => {
                const active = booking.id === activeBookingId;
                const position = positionWithin(segment, bounds);
                if (!position) return null;
                return (
                  <button
                    key={`${booking.id}:${segment.dayISO}`}
                    type="button"
                    onClick={() => onOpen(booking.id)}
                    style={{ top: `${position.topPercent}%`, height: `${position.heightPercent}%` }}
                    className={`absolute inset-x-1 z-10 overflow-hidden rounded-lg border px-2 py-1 text-left shadow-sm transition ${active ? "border-emerald-500 bg-emerald-100" : booking.status === "canceled" || booking.status === "no_show" ? "border-slate-200 bg-slate-50 opacity-70" : "border-emerald-200 bg-white hover:border-emerald-400 hover:bg-emerald-50"}`}
                  >
                    <p className="truncate text-[10px] font-bold text-slate-500">{segment.continuesBefore ? "◂ " : ""}{booking.startLabel}–{booking.endLabel}{segment.continuesAfter ? " ▸" : ""}</p>
                    <p className="truncate text-xs font-extrabold text-slate-800">{booking.customerName}</p>
                    <p className="truncate text-[10px] text-slate-500">{booking.pets.map((pet) => pet.petName).join(", ") || "Tanpa hewan"}</p>
                    {booking.resourceIds.length > 0 ? (
                      <p className="truncate text-[10px] font-semibold text-emerald-700">{booking.resourceIds.map((id) => resourceNames.get(id) ?? "Groomer").join(" · ")}</p>
                    ) : null}
                    {booking.locationLabel ? <p className="truncate text-[9px] text-slate-400">{booking.locationLabel}</p> : null}
                    <BookingBadges booking={booking} compact />
                  </button>
                );
              })}
              {dayBlackouts.map(({ blackout, segment }) => {
                const position = positionWithin(segment, bounds);
                if (!position) return null;
                return <div key={`${blackout.id}:${segment.dayISO}`} title={blackout.reason ?? "Tidak tersedia"} className="absolute inset-x-1 overflow-hidden rounded-lg border border-dashed border-slate-300 bg-slate-100/80 px-2 py-1" style={{ top: `${position.topPercent}%`, height: `${position.heightPercent}%` }}><p className="truncate text-[10px] font-bold text-slate-500">{resourceNames.get(blackout.resourceId) ?? "Groomer"} · tidak tersedia</p></div>;
              })}
          </section>
        );
      })}
        </div>
      </div>
    </div>
  );
}

function BookingDrawer({
  detail,
  onClose,
  canReadFinance,
  canUpdateBooking,
  canCancelBooking,
  branchResources,
  timeZone,
}: {
  detail: BookingDetail;
  onClose: () => void;
  canReadFinance: boolean;
  canUpdateBooking: boolean;
  canCancelBooking: boolean;
  branchResources: readonly ScheduleWorkspace["branchResources"][number][];
  timeZone: string;
}) {
  const waNumber = detail.customerPhone ? detail.customerPhone.replace(/\D/g, "").replace(/^0/, "62") : null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Detail booking">
      <button type="button" aria-label="Tutup detail" onClick={onClose} className="absolute inset-0 cursor-default bg-slate-950/30" />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-slate-200 bg-white shadow-2xl">
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-700">Detail booking</p>
            <h2 className="mt-1 truncate text-lg font-bold text-slate-900">{detail.customerName}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{detail.dayLabel} · {detail.startLabel}–{detail.endLabel}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Tutup" className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100">✕</button>
        </header>

        <div className="space-y-5 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={detail.status} />
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
              {detail.fulfillmentMode === "home" ? "Home service" : detail.fulfillmentMode === "pickup_delivery" ? "Antar-jemput" : "Di toko"}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link href={`/customers/${detail.customerId}`} className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800">Buka profil 360</Link>
            {waNumber ? <a href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer" className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100">WhatsApp</a> : null}
          </div>

          <section>
            <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Hewan &amp; layanan</h3>
            <div className="mt-2 space-y-2">
              {detail.pets.length === 0 ? <p className="text-xs text-slate-400">Belum ada hewan pada booking ini.</p> : null}
              {detail.pets.map((pet, index) => (
                <article key={`${pet.petName}-${index}`} className="rounded-xl bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-slate-800">{pet.petName}</p>
                    <StatusBadge status={pet.status} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{pet.resourceName ?? "Groomer belum ditentukan"}</p>
                  <ul className="mt-2 space-y-0.5">
                    {pet.services.map((service, serviceIndex) => (
                      <li key={`${service.name}-${serviceIndex}`} className="flex justify-between gap-2 text-xs text-slate-600">
                        <span className="truncate">{service.name}</span>
                        <span className="shrink-0 text-slate-400">{service.durationMinutes} menit</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>

          {detail.notes ? (
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Catatan booking</h3>
              <p className="mt-2 whitespace-pre-line rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">{detail.notes}</p>
            </section>
          ) : null}

          {detail.groomerNotes ? (
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Catatan groomer (internal)</h3>
              <p className="mt-2 whitespace-pre-line rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{detail.groomerNotes}</p>
            </section>
          ) : null}

          <section className="space-y-2 border-t border-slate-100 pt-4">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Tindakan</h3>
            {canUpdateBooking && isReschedulable(detail.status) ? (
              <BookingEditForm detail={detail} resources={branchResources} timeZone={timeZone} />
            ) : canUpdateBooking ? (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-500">
                Booking berstatus <strong>{detail.status}</strong> tidak dapat dijadwalkan ulang.
              </p>
            ) : null}
            {canCancelBooking && isCancellable(detail.status) ? <BookingCancelForm bookingId={detail.id} /> : null}
            {canUpdateBooking && isReschedulable(detail.status) ? <BookingSeriesForm detail={detail} /> : null}
            {!canUpdateBooking && !canCancelBooking ? (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-500">
                Izin Anda hanya mencakup melihat booking pada workspace ini.
              </p>
            ) : null}
          </section>
          <p className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-[11px] leading-5 text-slate-400">
            {canReadFinance ? "Invoice dari booking selesai menyusul pada Batch 1C." : "Perubahan layanan, harga, dan paket tidak tersedia pada batch ini."}
          </p>
        </div>
      </aside>
    </div>
  );
}
