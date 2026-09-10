/**
 * Function index:
 * - parseScheduleView: guards the untrusted view query parameter.
 * - resolveScheduleDays: expands a view plus anchor date into branch-local day columns.
 * - mondayOf: resolves the Monday that starts the week containing a date.
 * - resolveMinuteBounds: derives the visible time window, widened so nothing is hidden.
 * - positionWithin: converts a booking's minute span into grid percentages.
 * - clampSpan: keeps a span inside the rendered window without losing its identity.
 * - splitIntoDaySegments: places an instant range on every branch-local day it occupies.
 *
 * These functions are deliberately free of Supabase and React so the grid maths can
 * be tested directly. HomePaw hardcoded an 08:30-18:00 window as module constants,
 * which silently hid any booking outside it; resolveMinuteBounds widens instead.
 */
import { addDaysISO, isValidDateISO, zonedDateTimeToUtc } from "@/lib/timezone";

export const SCHEDULE_VIEWS = ["day", "3day", "week"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

export const SLOT_MINUTES = 30;
export const DEFAULT_DAY_START_MINUTES = 8 * 60 + 30;
export const DEFAULT_DAY_END_MINUTES = 18 * 60;

export const SCHEDULE_VIEW_LABELS: Record<ScheduleView, string> = {
  day: "Hari",
  "3day": "3 hari",
  week: "Minggu",
};

export function parseScheduleView(value: unknown): ScheduleView {
  return SCHEDULE_VIEWS.includes(value as ScheduleView) ? (value as ScheduleView) : "day";
}

export function mondayOf(dateISO: string): string {
  const [year, month, day] = dateISO.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDaysISO(dateISO, -((weekday + 6) % 7));
}

export function scheduleDayCount(view: ScheduleView): number {
  return view === "day" ? 1 : view === "3day" ? 3 : 7;
}

/**
 * Day columns for the requested view. `week` snaps to a Monday start so the same
 * seven columns render regardless of which day inside the week was requested.
 */
export function resolveScheduleDays(view: ScheduleView, anchorISO: string): string[] {
  const anchor = isValidDateISO(anchorISO) ? anchorISO : anchorISO;
  const start = view === "week" ? mondayOf(anchor) : anchor;
  return Array.from({ length: scheduleDayCount(view) }, (_, index) => addDaysISO(start, index));
}

export interface MinuteSpan {
  startMinutes: number;
  endMinutes: number;
}

export interface MinuteBounds {
  startMinutes: number;
  endMinutes: number;
}

/**
 * Visible window for the time axis. Starts from configured business hours, then
 * widens (snapped outward to whole slots) to cover anything scheduled outside them.
 * A booking is never invisible because it falls outside configured hours.
 */
export function resolveMinuteBounds(
  spans: readonly MinuteSpan[],
  configuredStart: number = DEFAULT_DAY_START_MINUTES,
  configuredEnd: number = DEFAULT_DAY_END_MINUTES,
): MinuteBounds {
  let start = Math.min(configuredStart, configuredEnd);
  let end = Math.max(configuredStart, configuredEnd);
  for (const span of spans) {
    if (span.endMinutes <= span.startMinutes) continue;
    start = Math.min(start, span.startMinutes);
    end = Math.max(end, span.endMinutes);
  }
  start = Math.max(0, Math.floor(start / SLOT_MINUTES) * SLOT_MINUTES);
  end = Math.min(24 * 60, Math.ceil(end / SLOT_MINUTES) * SLOT_MINUTES);
  if (end <= start) end = Math.min(24 * 60, start + SLOT_MINUTES);
  return { startMinutes: start, endMinutes: end };
}

export function slotMarkers(bounds: MinuteBounds, stepMinutes: number = SLOT_MINUTES * 2): number[] {
  const markers: number[] = [];
  for (let minute = bounds.startMinutes; minute <= bounds.endMinutes; minute += stepMinutes) markers.push(minute);
  return markers;
}

/** Clamps a span into the window while guaranteeing it stays at least one slot tall. */
export function clampSpan(span: MinuteSpan, bounds: MinuteBounds): MinuteSpan | null {
  const start = Math.max(span.startMinutes, bounds.startMinutes);
  const end = Math.min(Math.max(span.endMinutes, start + 1), bounds.endMinutes);
  if (start >= bounds.endMinutes || span.endMinutes <= bounds.startMinutes) return null;
  return { startMinutes: start, endMinutes: end };
}

export interface GridPosition {
  topPercent: number;
  heightPercent: number;
}

export function positionWithin(span: MinuteSpan, bounds: MinuteBounds): GridPosition | null {
  const total = bounds.endMinutes - bounds.startMinutes;
  if (total <= 0) return null;
  const clamped = clampSpan(span, bounds);
  if (!clamped) return null;
  const topPercent = ((clamped.startMinutes - bounds.startMinutes) / total) * 100;
  const heightPercent = ((clamped.endMinutes - clamped.startMinutes) / total) * 100;
  return { topPercent, heightPercent: Math.max(heightPercent, 1.5) };
}

export function minutesToLabel(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export interface DaySegment {
  dayISO: string;
  startMinutes: number;
  endMinutes: number;
  /** True when the occupancy began before this day's local midnight. */
  continuesBefore: boolean;
  /** True when the occupancy continues past this day's local midnight. */
  continuesAfter: boolean;
}

/**
 * Splits an instant range into one segment per branch-local day it occupies, restricted
 * to the supplied day columns.
 *
 * Without this, an occupancy that starts before the visible window or crosses local
 * midnight is invisible on every day except the one holding its start. The calendar
 * query uses an overlap condition, so such rows do reach the client and must be placed
 * on each day they actually cover.
 */
export function splitIntoDaySegments(
  startsAt: Date,
  endsAt: Date,
  days: readonly string[],
  timeZone: string,
): DaySegment[] {
  if (endsAt.getTime() <= startsAt.getTime()) return [];
  const segments: DaySegment[] = [];
  for (const dayISO of days) {
    const dayStart = zonedDateTimeToUtc(dayISO, 0, timeZone).getTime();
    const dayEnd = zonedDateTimeToUtc(addDaysISO(dayISO, 1), 0, timeZone).getTime();
    const overlapStart = Math.max(startsAt.getTime(), dayStart);
    const overlapEnd = Math.min(endsAt.getTime(), dayEnd);
    if (overlapEnd <= overlapStart) continue;
    segments.push({
      dayISO,
      startMinutes: Math.round((overlapStart - dayStart) / 60_000),
      endMinutes: Math.round((overlapEnd - dayStart) / 60_000),
      continuesBefore: startsAt.getTime() < dayStart,
      continuesAfter: endsAt.getTime() > dayEnd,
    });
  }
  return segments;
}
