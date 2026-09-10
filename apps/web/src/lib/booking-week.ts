/**
 * Function index:
 * - weekDayISOs: expands a Monday anchor into the seven branch-local calendar dates it spans.
 * - bookingLocalDayISO: resolves the calendar date a booking falls on in its OWN branch's zone.
 * - groupBookingsByLocalDay: buckets a week of bookings onto those seven dates.
 *
 * The weekly booking list spans every branch in the organization, and branches can run
 * different zones (WIB/WITA/WIT). A booking must be bucketed by the calendar day it falls
 * on in ITS OWN branch's zone, not the server process zone and not a single zone borrowed
 * from an unrelated branch — otherwise a late booking silently moves to the wrong day card.
 * This mirrors the branch-local day semantics `lib/schedule-layout.ts` already uses for the
 * dispatcher calendar.
 */
import { addDaysISO, zonedDayISO } from "@/lib/timezone";

export interface WeekBookingLike {
  branchId: string;
  startsAt: string;
}

export function weekDayISOs(weekStartISO: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysISO(weekStartISO, index));
}

export function bookingLocalDayISO(
  booking: WeekBookingLike,
  branchTimezoneById: ReadonlyMap<string, string>,
  fallbackTimezone: string,
): string {
  const timeZone = branchTimezoneById.get(booking.branchId) ?? fallbackTimezone;
  return zonedDayISO(new Date(booking.startsAt), timeZone);
}

export function groupBookingsByLocalDay<T extends WeekBookingLike>(
  bookings: readonly T[],
  weekStartISO: string,
  branchTimezoneById: ReadonlyMap<string, string>,
  fallbackTimezone: string,
): { dateISO: string; bookings: T[] }[] {
  const buckets = new Map(weekDayISOs(weekStartISO).map((dateISO) => [dateISO, [] as T[]]));
  for (const booking of bookings) {
    const dateISO = bookingLocalDayISO(booking, branchTimezoneById, fallbackTimezone);
    buckets.get(dateISO)?.push(booking);
  }
  return Array.from(buckets, ([dateISO, dayBookings]) => ({ dateISO, bookings: dayBookings }));
}
