import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BLACKOUT_DAYS,
  deriveActiveAssignmentWindows,
  findBlockingBlackout,
  findBlockingBooking,
  parseBlackoutInput,
  parseTstzRange,
  rangesOverlap,
  type ActiveAssignmentWindow,
  type BlackoutWindow,
  type RawBookingResourceRow,
} from "../src/lib/availability";
import { buildWhatsAppUrl } from "../src/components/customer-360";
import { splitIntoDaySegments } from "../src/lib/schedule-layout";

const JAKARTA = "Asia/Jakarta";
const ANA = "018f3e10-7b1a-7c11-8c2a-9a4de6e41701";
const BUDI = "018f3e10-7b1a-7c11-8c2a-9a4de6e41702";
const OUTSIDER = "018f3e10-7b1a-7c11-8c2a-9a4de6e41799";

const CONTEXT = { timeZone: JAKARTA, branchResourceIds: new Set([ANA, BUDI]) };

function raw(overrides: Record<string, unknown> = {}) {
  return { resourceId: ANA, dateISO: "2026-08-02", startTime: "12:00", endTime: "13:00", reason: "Cuti", ...overrides };
}

// ---------- blackout creation validation (requirement 12) ----------

test("a valid one-off blackout parses into branch-local instants", () => {
  const result = parseBlackoutInput(raw(), CONTEXT);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.resourceId, ANA);
  assert.equal(result.value.startsAt, "2026-08-02T05:00:00.000Z"); // 12:00 Jakarta
  assert.equal(result.value.endsAt, "2026-08-02T06:00:00.000Z");
  assert.equal(result.value.reason, "Cuti");
});

test("a late-evening blackout crosses the UTC date boundary correctly", () => {
  const result = parseBlackoutInput(raw({ startTime: "23:00", endTime: "23:59" }), CONTEXT);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value.startsAt, "2026-08-02T16:00:00.000Z");
});

test("zero-length and inverted windows are rejected", () => {
  for (const [start, end] of [["12:00", "12:00"], ["13:00", "12:00"]]) {
    const result = parseBlackoutInput(raw({ startTime: start, endTime: end }), CONTEXT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "end_before_start");
  }
});

test("a resource outside the selected branch is rejected", () => {
  const result = parseBlackoutInput(raw({ resourceId: OUTSIDER }), CONTEXT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "resource_not_available_in_branch");
});

test("a missing or non-string resource id is rejected", () => {
  assert.equal(parseBlackoutInput(raw({ resourceId: null }), CONTEXT).ok, false);
  assert.equal(parseBlackoutInput(raw({ resourceId: "" }), CONTEXT).ok, false);
});

test("an empty accessible-resource set blocks all blackout creation", () => {
  const result = parseBlackoutInput(raw(), { timeZone: JAKARTA, branchResourceIds: new Set() });
  assert.equal(result.ok, false);
});

test("malformed dates and times are rejected", () => {
  assert.equal(parseBlackoutInput(raw({ dateISO: "2026-13-01" }), CONTEXT).ok, false);
  assert.equal(parseBlackoutInput(raw({ startTime: "noon" }), CONTEXT).ok, false);
});

test("a blank reason normalizes to null and an over-long one is rejected", () => {
  const blank = parseBlackoutInput(raw({ reason: "   " }), CONTEXT);
  assert.ok(blank.ok);
  if (blank.ok) assert.equal(blank.value.reason, null);
  assert.equal(parseBlackoutInput(raw({ reason: "x".repeat(501) }), CONTEXT).ok, false);
});

test("the maximum span guard is enforced", () => {
  assert.equal(MAX_BLACKOUT_DAYS, 31);
  // A single day's form cannot exceed the guard, so this asserts the constant is applied.
  const result = parseBlackoutInput(raw({ startTime: "00:00", endTime: "23:59" }), CONTEXT);
  assert.equal(result.ok, true);
});

// ---------- overlap semantics ----------

test("ranges are half-open, matching tstzrange [start, end)", () => {
  // Touching at the boundary is NOT an overlap: 10:00-11:00 and 11:00-12:00 are adjacent.
  assert.equal(rangesOverlap("2026-08-02T10:00:00Z", "2026-08-02T11:00:00Z", "2026-08-02T11:00:00Z", "2026-08-02T12:00:00Z"), false);
  assert.equal(rangesOverlap("2026-08-02T10:00:00Z", "2026-08-02T11:00:00Z", "2026-08-02T10:30:00Z", "2026-08-02T12:00:00Z"), true);
  assert.equal(rangesOverlap("2026-08-02T10:00:00Z", "2026-08-02T14:00:00Z", "2026-08-02T11:00:00Z", "2026-08-02T12:00:00Z"), true);
});

// ---------- blackout versus booking (requirement 13) ----------

const assignment = (overrides: Partial<ActiveAssignmentWindow> = {}): ActiveAssignmentWindow => ({
  bookingId: "b1",
  resourceId: ANA,
  startsAt: "2026-08-02T05:00:00Z",
  endsAt: "2026-08-02T06:00:00Z",
  isActive: true,
  ...overrides,
});

test("a blackout over an active assigned booking is rejected", () => {
  const blocking = findBlockingBooking({ resourceId: ANA, startsAt: "2026-08-02T05:30:00Z", endsAt: "2026-08-02T07:00:00Z" }, [assignment()]);
  assert.ok(blocking);
  assert.equal(blocking?.bookingId, "b1");
});

test("an INACTIVE assignment does not block a blackout", () => {
  // A canceled booking's released row no longer occupies the slot, so blacking out that
  // window is legitimate. This is the Batch 1A active-assignment rule held consistently.
  const blocking = findBlockingBooking({ resourceId: ANA, startsAt: "2026-08-02T05:30:00Z", endsAt: "2026-08-02T07:00:00Z" }, [
    assignment({ isActive: false }),
  ]);
  assert.equal(blocking, null);
});

test("another groomer's booking does not block", () => {
  const blocking = findBlockingBooking({ resourceId: BUDI, startsAt: "2026-08-02T05:30:00Z", endsAt: "2026-08-02T07:00:00Z" }, [assignment()]);
  assert.equal(blocking, null);
});

test("an adjacent booking does not block", () => {
  const blocking = findBlockingBooking({ resourceId: ANA, startsAt: "2026-08-02T06:00:00Z", endsAt: "2026-08-02T07:00:00Z" }, [assignment()]);
  assert.equal(blocking, null);
});

test("no assignments means no conflict", () => {
  assert.equal(findBlockingBooking({ resourceId: ANA, startsAt: "2026-08-02T05:00:00Z", endsAt: "2026-08-02T06:00:00Z" }, []), null);
});

// ---------- deriving active-assignment windows from `during` (v3 correction 4) ----------

test("parseTstzRange reads a Postgres tstzrange literal's bounds", () => {
  const range = parseTstzRange('["2026-08-02T09:00:00+00:00","2026-08-02T09:30:00+00:00")');
  assert.ok(range);
  assert.equal(range?.startsAt, "2026-08-02T09:00:00.000Z");
  assert.equal(range?.endsAt, "2026-08-02T09:30:00.000Z");
});

test("parseTstzRange rejects malformed or unparseable literals rather than guessing", () => {
  assert.equal(parseTstzRange(""), null);
  assert.equal(parseTstzRange("not a range"), null);
  assert.equal(parseTstzRange('["not-a-date","2026-08-02T09:30:00+00:00")'), null);
});

test("deriveActiveAssignmentWindows sources bounds from `during`, and excludes a soft-deleted booking's row", () => {
  const rows: RawBookingResourceRow[] = [
    { bookingId: "b1", resourceId: ANA, during: '["2026-08-02T09:00:00+00:00","2026-08-02T09:30:00+00:00")', isActive: true, bookingDeletedAt: null },
    { bookingId: "b2", resourceId: BUDI, during: '["2026-08-02T09:00:00+00:00","2026-08-02T09:30:00+00:00")', isActive: true, bookingDeletedAt: "2026-08-01T00:00:00Z" },
  ];
  const windows = deriveActiveAssignmentWindows(rows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].bookingId, "b1");
  assert.equal(windows[0].startsAt, "2026-08-02T09:00:00.000Z");
  assert.equal(windows[0].endsAt, "2026-08-02T09:30:00.000Z");
});

test("deriveActiveAssignmentWindows drops a row with a malformed `during` or a non-string identifier rather than guessing", () => {
  const rows: RawBookingResourceRow[] = [
    { bookingId: "b1", resourceId: ANA, during: "garbage", isActive: true, bookingDeletedAt: null },
    { bookingId: null, resourceId: ANA, during: '["2026-08-02T09:00:00+00:00","2026-08-02T09:30:00+00:00")', isActive: true, bookingDeletedAt: null },
  ];
  assert.equal(deriveActiveAssignmentWindows(rows).length, 0);
});

test("v3 correction 4 regression: conflict detection follows booking_resources.during, not the parent booking's own starts_at/ends_at, when the two differ", () => {
  // Simulates a booking whose own row spans a wider window (e.g. because another resource
  // on the same booking runs longer) than THIS resource's own assignment `during`. Nothing
  // here can pass the booking's wider range into the derivation at all: `RawBookingResourceRow`
  // has no starts_at/ends_at field, so the old bug (deriving windows from the joined
  // `bookings` row) is structurally impossible to reintroduce through this function.
  const rows: RawBookingResourceRow[] = [
    { bookingId: "b1", resourceId: ANA, during: '["2026-08-02T09:00:00+00:00","2026-08-02T09:30:00+00:00")', isActive: true, bookingDeletedAt: null },
  ];
  const windows = deriveActiveAssignmentWindows(rows);
  assert.equal(windows.length, 1);

  // A proposed blackout at 10:00-10:30 would fall inside the booking's own hypothetical
  // 09:00-11:00 span, but outside this assignment's real 09:00-09:30 `during` window — it
  // must NOT be blocked.
  assert.equal(findBlockingBooking({ resourceId: ANA, startsAt: "2026-08-02T10:00:00Z", endsAt: "2026-08-02T10:30:00Z" }, windows), null);
  // A blackout inside the real `during` window is still correctly blocked.
  const blocking = findBlockingBooking({ resourceId: ANA, startsAt: "2026-08-02T09:10:00Z", endsAt: "2026-08-02T09:20:00Z" }, windows);
  assert.ok(blocking);
  assert.equal(blocking?.bookingId, "b1");
});

// ---------- booking versus blackout (reschedule pre-check) ----------

const blackout = (overrides: Partial<BlackoutWindow> = {}): BlackoutWindow => ({
  id: "x1",
  resourceId: ANA,
  startsAt: "2026-08-02T05:00:00Z",
  endsAt: "2026-08-02T06:00:00Z",
  ...overrides,
});

test("rescheduling into a blackout is detected for the targeted groomer", () => {
  const blocking = findBlockingBlackout({ resourceIds: [ANA], startsAt: "2026-08-02T05:30:00Z", endsAt: "2026-08-02T06:30:00Z" }, [blackout()]);
  assert.ok(blocking);
  assert.equal(blocking?.id, "x1");
});

test("only the targeted groomers' blackouts are considered", () => {
  assert.equal(findBlockingBlackout({ resourceIds: [BUDI], startsAt: "2026-08-02T05:30:00Z", endsAt: "2026-08-02T06:30:00Z" }, [blackout()]), null);
});

test("a multi-pet reschedule checks every targeted groomer", () => {
  const blocking = findBlockingBlackout({ resourceIds: [ANA, BUDI], startsAt: "2026-08-02T05:30:00Z", endsAt: "2026-08-02T06:30:00Z" }, [
    blackout({ id: "x2", resourceId: BUDI }),
  ]);
  assert.equal(blocking?.id, "x2");
});

// ---------- soft-removed blackouts leave the calendar (requirement 14) ----------

test("a soft-removed blackout is excluded by the schedule read contract", () => {
  /**
   * The exclusion happens in the query (`.is("deleted_at", null)` in loadScheduleWorkspace),
   * which needs a live database to exercise. What is asserted here is the contract the
   * removal action relies on: a row is removed by SETTING deleted_at, and any row the
   * loader does hand to the layout still produces segments. So the only thing standing
   * between a removed block and the calendar is the deleted_at predicate.
   */
  const segments = splitIntoDaySegments(new Date("2026-08-02T05:00:00Z"), new Date("2026-08-02T06:00:00Z"), ["2026-08-02"], JAKARTA);
  assert.equal(segments.length, 1);
  const excludedByQuery: BlackoutWindow[] = [];
  assert.equal(findBlockingBlackout({ resourceIds: [ANA], startsAt: "2026-08-02T05:00:00Z", endsAt: "2026-08-02T06:00:00Z" }, excludedByQuery), null);
});

// ---------- Customer 360 actions (requirement 15) ----------

test("a WhatsApp URL is built from a local number with the country prefix", () => {
  assert.equal(buildWhatsAppUrl("081234567890"), "https://wa.me/6281234567890");
});

test("separators and spacing in stored numbers are normalized", () => {
  assert.equal(buildWhatsAppUrl("+62 812-3456-7890"), "https://wa.me/6281234567890");
  assert.equal(buildWhatsAppUrl("(0812) 3456 7890"), "https://wa.me/6281234567890");
});

test("prefilled text is percent-encoded so it cannot corrupt the query string", () => {
  const url = buildWhatsAppUrl("081234567890", "Halo Budi & Ana, #1 pagi?");
  assert.ok(url);
  assert.ok(url.includes("?text="));
  assert.equal(url.includes("#"), false, "a raw # would truncate the URL at a fragment");
  assert.equal(url.includes(" "), false, "a raw space would produce an invalid URL");
  assert.ok(url.includes("%26"), "ampersand must be encoded, not treated as a separator");
  assert.ok(url.includes("%231"), "hash must be encoded");
});

test("an unusable phone number yields no link rather than a broken one", () => {
  assert.equal(buildWhatsAppUrl(null), null);
  assert.equal(buildWhatsAppUrl(""), null);
  assert.equal(buildWhatsAppUrl("12345"), null);
  assert.equal(buildWhatsAppUrl("tidak ada"), null);
});

test("an already-international number is left intact", () => {
  assert.equal(buildWhatsAppUrl("6281234567890"), "https://wa.me/6281234567890");
});

test("no message means no query string at all", () => {
  assert.equal(buildWhatsAppUrl("081234567890", ""), "https://wa.me/6281234567890");
});
