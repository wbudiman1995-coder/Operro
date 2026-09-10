/**
 * Function index:
 * - parseBlackoutInput: validates untrusted one-off blackout input against server facts.
 * - rangesOverlap: half-open interval overlap, matching tstzrange [start, end).
 * - parseTstzRange: parses a Postgres tstzrange text literal into ISO bounds.
 * - deriveActiveAssignmentWindows: booking_resources rows -> windows, sourced from `during`.
 * - findBlockingBooking: best-effort blackout-versus-booking conflict detection.
 * - findBlockingBlackout: best-effort booking-versus-blackout detection for reschedules.
 *
 * One-off blackouts are written to `resource_availability` as
 * `kind = 'blackout'`, `day_of_week = null`, explicit `starts_at`/`ends_at`, human reason
 * in `notes`, and structured provenance in `metadata`. Verified against migration
 * 20260721000500: `day_of_week` is nullable under `chk_resource_availability_dow`, and the
 * table carries `deleted_at`, so removal is a soft delete consistent with Batch 1A reads
 * which already filter `deleted_at is null`.
 *
 * RACE LIMITATION, stated here because it cannot be fixed without a migration: the frozen
 * schema has an exclusion constraint between booking assignments
 * (`ex_booking_resources_no_overlap`) but NONE between blackouts and booking assignments.
 * Every blackout-versus-booking check in this module is therefore advisory. Two concurrent
 * requests — one creating a blackout, one moving a booking into that window — can both
 * succeed. The database will still prevent two bookings from double-booking a resource.
 */
import { isValidDateISO, zonedDateTimeToUtc } from "@/lib/timezone";
import { parseClockMinutes, type ParseResult } from "@/lib/booking-mutations";

export const MAX_BLACKOUT_REASON_LENGTH = 500;
/** Guards against a single blackout row covering an implausible span. */
export const MAX_BLACKOUT_DAYS = 31;

export interface BlackoutRawInput {
  resourceId: unknown;
  dateISO: unknown;
  startTime: unknown;
  endTime: unknown;
  reason: unknown;
}

export interface BlackoutContext {
  timeZone: string;
  branchResourceIds: ReadonlySet<string>;
}

export interface BlackoutParsed {
  resourceId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export function parseBlackoutInput(raw: BlackoutRawInput, context: BlackoutContext): ParseResult<BlackoutParsed> {
  if (typeof raw.resourceId !== "string" || !context.branchResourceIds.has(raw.resourceId)) {
    return { ok: false, reason: "resource_not_available_in_branch" };
  }
  if (!isValidDateISO(raw.dateISO)) return { ok: false, reason: "invalid_date" };
  const startMinutes = parseClockMinutes(raw.startTime);
  const endMinutes = parseClockMinutes(raw.endTime);
  if (startMinutes === null) return { ok: false, reason: "invalid_start_time" };
  if (endMinutes === null) return { ok: false, reason: "invalid_end_time" };
  // A zero-length window would occupy nothing and silently do nothing.
  if (endMinutes <= startMinutes) return { ok: false, reason: "end_before_start" };

  const reasonValue = raw.reason === null || raw.reason === undefined ? "" : String(raw.reason).trim();
  if (reasonValue.length > MAX_BLACKOUT_REASON_LENGTH) return { ok: false, reason: "reason_too_long" };

  const startsAt = zonedDateTimeToUtc(raw.dateISO, startMinutes, context.timeZone);
  const endsAt = zonedDateTimeToUtc(raw.dateISO, endMinutes, context.timeZone);
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, reason: "end_before_start" };
  if (endsAt.getTime() - startsAt.getTime() > MAX_BLACKOUT_DAYS * 86_400_000) return { ok: false, reason: "window_too_long" };

  return {
    ok: true,
    value: {
      resourceId: raw.resourceId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      reason: reasonValue.length > 0 ? reasonValue : null,
    },
  };
}

/** Half-open overlap, matching how `during` is stored as `[starts_at, ends_at)`. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime() && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

const TSTZRANGE_PATTERN = /^[[(]\s*"?([^",]*)"?\s*,\s*"?([^",]*)"?\s*[)\]]$/;

/**
 * Parses a Postgres tstzrange text literal (e.g. `["2026-01-01 09:00:00+00","2026-01-01
 * 10:00:00+00")`) into ISO bounds. Returns null for anything malformed or unbounded,
 * rather than guessing.
 */
export function parseTstzRange(range: string): { startsAt: string; endsAt: string } | null {
  const match = TSTZRANGE_PATTERN.exec(range.trim());
  if (!match) return null;
  const [, lowerRaw, upperRaw] = match;
  if (!lowerRaw || !upperRaw) return null;
  const lower = new Date(lowerRaw);
  const upper = new Date(upperRaw);
  if (Number.isNaN(lower.getTime()) || Number.isNaN(upper.getTime())) return null;
  return { startsAt: lower.toISOString(), endsAt: upper.toISOString() };
}

export interface ActiveAssignmentWindow {
  bookingId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

/** Raw shape of one `booking_resources` row joined to its parent booking's `deleted_at`. */
export interface RawBookingResourceRow {
  bookingId: unknown;
  resourceId: unknown;
  during: unknown;
  isActive: unknown;
  bookingDeletedAt: unknown;
}

/**
 * Derives active-assignment windows from raw `booking_resources` rows.
 *
 * The window bounds come from `during` — the range the GiST exclusion constraint and the
 * `tg_bookings_release_resources` trigger actually govern — never from the parent
 * booking's `starts_at`/`ends_at`. Those columns are not the same thing: nothing
 * guarantees they cannot diverge from a specific assignment's `during`, so a caller must
 * not pass them into this function at all, let alone use them as the window.
 */
export function deriveActiveAssignmentWindows(rows: readonly RawBookingResourceRow[]): ActiveAssignmentWindow[] {
  return rows.flatMap((row) => {
    if (row.bookingDeletedAt !== null && row.bookingDeletedAt !== undefined) return [];
    if (typeof row.bookingId !== "string" || typeof row.resourceId !== "string" || typeof row.during !== "string") return [];
    const range = parseTstzRange(row.during);
    if (!range) return [];
    return [{ bookingId: row.bookingId, resourceId: row.resourceId, startsAt: range.startsAt, endsAt: range.endsAt, isActive: row.isActive === true }];
  });
}

/**
 * Returns the first ACTIVE assignment a proposed blackout would sit on top of.
 *
 * Inactive assignments are ignored: a canceled booking's released row no longer occupies
 * the slot, so blacking out that window is legitimate.
 */
export function findBlockingBooking(
  proposal: { resourceId: string; startsAt: string; endsAt: string },
  assignments: readonly ActiveAssignmentWindow[],
): ActiveAssignmentWindow | null {
  return (
    assignments.find(
      (assignment) =>
        assignment.isActive &&
        assignment.resourceId === proposal.resourceId &&
        rangesOverlap(proposal.startsAt, proposal.endsAt, assignment.startsAt, assignment.endsAt),
    ) ?? null
  );
}

export interface BlackoutWindow {
  id: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
}

/** Returns the first blackout that would cover a proposed booking window. */
export function findBlockingBlackout(
  proposal: { resourceIds: readonly string[]; startsAt: string; endsAt: string },
  blackouts: readonly BlackoutWindow[],
): BlackoutWindow | null {
  const targets = new Set(proposal.resourceIds);
  return (
    blackouts.find(
      (blackout) => targets.has(blackout.resourceId) && rangesOverlap(proposal.startsAt, proposal.endsAt, blackout.startsAt, blackout.endsAt),
    ) ?? null
  );
}
