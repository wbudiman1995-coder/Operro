/**
 * Function index:
 * - zoneOffsetMinutes: resolves a time zone's UTC offset at a specific instant.
 * - zonedDayISO: renders the calendar date an instant falls on inside a time zone.
 * - zonedMinutesFromMidnight: renders an instant as minutes after local midnight.
 * - zonedDateTimeToUtc: converts a local calendar date plus minutes into a UTC instant.
 * - addDaysISO: shifts a YYYY-MM-DD string by whole days without time-zone drift.
 * - isValidDateISO: guards untrusted YYYY-MM-DD input.
 * - formatZonedTime: renders HH:mm for a given instant and time zone.
 * - zonedDaysBetween: whole branch-local days between two instants.
 * - formatZonedDate / formatZonedDateTime / formatZonedDayLong: zone-bound display formatters.
 *
 * Every scheduling boundary in Operro is a branch-local boundary. Computing them in
 * UTC shifts each boundary by the branch offset (7 hours for Asia/Jakarta), which
 * silently moves bookings between days and moves inactive-day buckets between
 * periods. These helpers keep that arithmetic in one tested place.
 */

const DATE_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateISO(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_ISO_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function zonedParts(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl can emit hour 24 for midnight under hour12:false; normalize to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

export function zonedDayISO(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function zonedMinutesFromMidnight(instant: Date, timeZone: string): number {
  const { hour, minute } = zonedParts(instant, timeZone);
  return hour * 60 + minute;
}

/**
 * Converts a branch-local calendar date and minute offset into the matching UTC
 * instant. Two correction passes are used because the offset itself depends on the
 * instant being resolved; this converges for every zone without a same-hour
 * transition, which includes Asia/Jakarta (no DST).
 */
export function zonedDateTimeToUtc(dateISO: string, minutesFromMidnight: number, timeZone: string): Date {
  const [year, month, day] = dateISO.split("-").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day) + minutesFromMidnight * 60_000;
  let instant = new Date(wallClockAsUtc);
  for (let pass = 0; pass < 2; pass += 1) {
    instant = new Date(wallClockAsUtc - zoneOffsetMinutes(instant, timeZone) * 60_000);
  }
  return instant;
}

export function addDaysISO(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function formatZonedTime(instant: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(instant, timeZone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Whole branch-local days elapsed between two instants, floored. */
export function zonedDaysBetween(from: Date, to: Date, timeZone: string): number {
  const fromDay = zonedDateTimeToUtc(zonedDayISO(from, timeZone), 0, timeZone).getTime();
  const toDay = zonedDateTimeToUtc(zonedDayISO(to, timeZone), 0, timeZone).getTime();
  return Math.round((toDay - fromDay) / 86_400_000);
}

/**
 * Zone-bound display formatters.
 *
 * `Intl.DateTimeFormat` silently falls back to the process time zone when `timeZone`
 * is omitted, so a server rendering in UTC shows the wrong calendar date for every
 * Jakarta booking after 17:00 local. These wrappers make the zone a required argument
 * so a call site cannot forget it.
 */
export function formatZonedDate(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone }).format(
    typeof instant === "string" ? new Date(instant) : instant,
  );
}

export function formatZonedDateTime(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}

export function formatZonedDayLong(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}
