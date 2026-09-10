import assert from "node:assert/strict";
import test from "node:test";

import { resolveDefaultTimezone, UNRESOLVED_TIMEZONE_FALLBACK } from "../src/lib/branch-context";
import { formatZonedDate, formatZonedDateTime, formatZonedDayLong, zonedDayISO } from "../src/lib/timezone";

const JAKARTA = "Asia/Jakarta";

/**
 * 2026-08-02T17:30:00Z is 2026-08-02 in UTC but already 2026-08-03 in Jakarta. Any
 * formatter that omits `timeZone` inherits the process zone, which is UTC on the
 * deployment target, so this instant is the regression case for the whole class of bug.
 */
const CROSS_MIDNIGHT = "2026-08-02T17:30:00Z";

test("the fixture really does straddle the UTC/Jakarta date boundary", () => {
  assert.equal(zonedDayISO(new Date(CROSS_MIDNIGHT), "UTC"), "2026-08-02");
  assert.equal(zonedDayISO(new Date(CROSS_MIDNIGHT), JAKARTA), "2026-08-03");
});

test("formatZonedDate reports the branch calendar date, not the UTC one", () => {
  const jakarta = formatZonedDate(CROSS_MIDNIGHT, JAKARTA);
  const utc = formatZonedDate(CROSS_MIDNIGHT, "UTC");
  assert.match(jakarta, /3 Agu 2026/);
  assert.match(utc, /2 Agu 2026/);
  assert.notEqual(jakarta, utc);
});

test("formatZonedDateTime reports the branch wall clock", () => {
  assert.match(formatZonedDateTime(CROSS_MIDNIGHT, JAKARTA), /3 Agu 2026, 00\.30|3 Agu 2026, 00:30/);
  assert.match(formatZonedDateTime(CROSS_MIDNIGHT, "UTC"), /2 Agu 2026, 17\.30|2 Agu 2026, 17:30/);
});

test("formatZonedDayLong reports the branch weekday", () => {
  // 2026-08-02 is a Sunday; 2026-08-03 is a Monday.
  assert.match(formatZonedDayLong(CROSS_MIDNIGHT, "UTC"), /Minggu/);
  assert.match(formatZonedDayLong(CROSS_MIDNIGHT, JAKARTA), /Senin/);
});

test("formatters accept both Date and ISO string inputs identically", () => {
  assert.equal(formatZonedDate(new Date(CROSS_MIDNIGHT), JAKARTA), formatZonedDate(CROSS_MIDNIGHT, JAKARTA));
  assert.equal(formatZonedDateTime(new Date(CROSS_MIDNIGHT), JAKARTA), formatZonedDateTime(CROSS_MIDNIGHT, JAKARTA));
});

test("a branch in a negative offset zone also shifts the reported date", () => {
  // 2026-08-02T02:00:00Z is still 2026-08-01 in Los Angeles (UTC-7).
  assert.match(formatZonedDate("2026-08-02T02:00:00Z", "America/Los_Angeles"), /1 Agu 2026/);
  assert.match(formatZonedDate("2026-08-02T02:00:00Z", "UTC"), /2 Agu 2026/);
});

test("default branch timezone prefers the explicit default branch", () => {
  const resolved = resolveDefaultTimezone([
    { id: "b1", timezone: "Asia/Makassar", is_default: false },
    { id: "b2", timezone: JAKARTA, is_default: true },
  ]);
  assert.equal(resolved.timezone, JAKARTA);
  assert.equal(resolved.branchId, "b2");
});

test("default branch timezone falls back to the first branch when none is flagged", () => {
  const resolved = resolveDefaultTimezone([{ id: "b1", timezone: "Asia/Makassar", is_default: false }]);
  assert.equal(resolved.timezone, "Asia/Makassar");
  assert.equal(resolved.branchId, "b1");
});

test("timezone resolution reports an explicit fallback when no branch is readable", () => {
  const resolved = resolveDefaultTimezone([]);
  assert.equal(resolved.timezone, UNRESOLVED_TIMEZONE_FALLBACK);
  assert.equal(resolved.branchId, null);
});
