import assert from "node:assert/strict";
import test from "node:test";

import { bookingLocalDayISO, groupBookingsByLocalDay, weekDayISOs } from "../src/lib/booking-week";

const JAKARTA = "Asia/Jakarta"; // WIB, UTC+7
const MAKASSAR = "Asia/Makassar"; // WITA, UTC+8

test("expands a Monday anchor into its seven calendar dates", () => {
  assert.deepEqual(weekDayISOs("2026-08-03"), [
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
  ]);
});

test("crosses a month boundary without drift", () => {
  assert.deepEqual(weekDayISOs("2026-08-31"), [
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
    "2026-09-05",
    "2026-09-06",
  ]);
});

test("a booking is bucketed by its OWN branch's zone, not a shared org zone", () => {
  // 2026-08-05T17:30:00Z is still 5 Aug in Jakarta (UTC+7, 00:30 local next day... actually
  // 17:30Z + 7h = 00:30 the next day) but only 1:30 the next day in Makassar (UTC+8).
  // Both branches see the SAME instant land on 2026-08-06 local, which is the point: a
  // single shared "org zone" would have put it on 2026-08-05 (the UTC date) for both,
  // silently shifting it a day early on the board.
  const instant = "2026-08-05T17:30:00Z";
  const byBranch = new Map([
    ["jakarta-branch", JAKARTA],
    ["makassar-branch", MAKASSAR],
  ]);
  assert.equal(bookingLocalDayISO({ branchId: "jakarta-branch", startsAt: instant }, byBranch, "UTC"), "2026-08-06");
  assert.equal(bookingLocalDayISO({ branchId: "makassar-branch", startsAt: instant }, byBranch, "UTC"), "2026-08-06");
  assert.equal(bookingLocalDayISO({ branchId: "jakarta-branch", startsAt: instant }, new Map(), "UTC"), "2026-08-05");
});

test("two branches in different zones disagree on the day for a near-midnight instant", () => {
  // 2026-08-05T16:30:00Z: 23:30 in Jakarta (still 5 Aug) but 00:30 in Makassar (already 6 Aug).
  const instant = "2026-08-05T16:30:00Z";
  const byBranch = new Map([
    ["jakarta-branch", JAKARTA],
    ["makassar-branch", MAKASSAR],
  ]);
  assert.equal(bookingLocalDayISO({ branchId: "jakarta-branch", startsAt: instant }, byBranch, "UTC"), "2026-08-05");
  assert.equal(bookingLocalDayISO({ branchId: "makassar-branch", startsAt: instant }, byBranch, "UTC"), "2026-08-06");
});

test("falls back to the supplied default zone when the branch is not in the map", () => {
  assert.equal(
    bookingLocalDayISO({ branchId: "unknown-branch", startsAt: "2026-08-05T17:30:00Z" }, new Map(), JAKARTA),
    "2026-08-06",
  );
});

test("groups a week of bookings onto all seven day buckets, including empty ones", () => {
  const byBranch = new Map([["jakarta-branch", JAKARTA]]);
  const bookings = [
    { id: "a", branchId: "jakarta-branch", startsAt: "2026-08-03T02:00:00Z" }, // 09:00 WIB, 3 Aug
    { id: "b", branchId: "jakarta-branch", startsAt: "2026-08-05T17:30:00Z" }, // 00:30 WIB, 6 Aug
  ];
  const groups = groupBookingsByLocalDay(bookings, "2026-08-03", byBranch, "UTC");
  assert.equal(groups.length, 7);
  assert.deepEqual(
    groups.map((group) => group.dateISO),
    weekDayISOs("2026-08-03"),
  );
  assert.deepEqual(groups.find((group) => group.dateISO === "2026-08-03")?.bookings.map((b) => b.id), ["a"]);
  assert.deepEqual(groups.find((group) => group.dateISO === "2026-08-06")?.bookings.map((b) => b.id), ["b"]);
  assert.deepEqual(groups.find((group) => group.dateISO === "2026-08-04")?.bookings, []);
});

test("a booking whose branch zone pushes it outside the requested week is dropped, not misfiled", () => {
  const byBranch = new Map([["jakarta-branch", JAKARTA]]);
  // 2026-08-01T17:30:00Z is 00:30 WIB on 2 Aug, one day before the week (which starts
  // 3 Aug), so it must not appear in any bucket of this week.
  const bookings = [{ id: "early", branchId: "jakarta-branch", startsAt: "2026-08-01T17:30:00Z" }];
  const groups = groupBookingsByLocalDay(bookings, "2026-08-03", byBranch, "UTC");
  const allBucketed = groups.flatMap((group) => group.bookings);
  assert.deepEqual(allBucketed, []);
});
