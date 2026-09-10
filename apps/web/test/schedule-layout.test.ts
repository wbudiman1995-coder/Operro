import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DAY_END_MINUTES,
  DEFAULT_DAY_START_MINUTES,
  clampSpan,
  minutesToLabel,
  mondayOf,
  parseScheduleView,
  positionWithin,
  resolveMinuteBounds,
  resolveScheduleDays,
  scheduleDayCount,
  slotMarkers,
} from "../src/lib/schedule-layout";

test("guards the view parameter against arbitrary input", () => {
  assert.equal(parseScheduleView("week"), "week");
  assert.equal(parseScheduleView("3day"), "3day");
  assert.equal(parseScheduleView("month"), "day");
  assert.equal(parseScheduleView(undefined), "day");
  assert.equal(parseScheduleView({ toString: () => "week" }), "day");
});

test("expands each view into the right number of day columns", () => {
  assert.equal(scheduleDayCount("day"), 1);
  assert.deepEqual(resolveScheduleDays("day", "2026-08-05"), ["2026-08-05"]);
  assert.deepEqual(resolveScheduleDays("3day", "2026-08-05"), ["2026-08-05", "2026-08-06", "2026-08-07"]);
});

test("week view snaps to a Monday start regardless of the requested day", () => {
  // 2026-08-05 is a Wednesday; 2026-08-09 is the Sunday of the same week.
  assert.equal(mondayOf("2026-08-05"), "2026-08-03");
  assert.equal(mondayOf("2026-08-09"), "2026-08-03");
  assert.equal(mondayOf("2026-08-03"), "2026-08-03");
  assert.deepEqual(resolveScheduleDays("week", "2026-08-05"), resolveScheduleDays("week", "2026-08-09"));
  assert.equal(resolveScheduleDays("week", "2026-08-05")[0], "2026-08-03");
  assert.equal(resolveScheduleDays("week", "2026-08-05").length, 7);
});

test("uses configured business hours when nothing falls outside them", () => {
  const bounds = resolveMinuteBounds([{ startMinutes: 600, endMinutes: 660 }]);
  assert.equal(bounds.startMinutes, DEFAULT_DAY_START_MINUTES);
  assert.equal(bounds.endMinutes, DEFAULT_DAY_END_MINUTES);
});

test("widens the window so an early or late booking is never hidden", () => {
  const bounds = resolveMinuteBounds([
    { startMinutes: 6 * 60 + 15, endMinutes: 7 * 60 },
    { startMinutes: 19 * 60, endMinutes: 20 * 60 + 45 },
  ]);
  // Snapped outward to whole slots: 06:00 and 21:00.
  assert.equal(bounds.startMinutes, 6 * 60);
  assert.equal(bounds.endMinutes, 21 * 60);
});

test("ignores zero-length and inverted spans when widening", () => {
  const bounds = resolveMinuteBounds([{ startMinutes: 120, endMinutes: 120 }, { startMinutes: 300, endMinutes: 60 }]);
  assert.equal(bounds.startMinutes, DEFAULT_DAY_START_MINUTES);
  assert.equal(bounds.endMinutes, DEFAULT_DAY_END_MINUTES);
});

test("never produces an empty window", () => {
  const bounds = resolveMinuteBounds([], 600, 600);
  assert.ok(bounds.endMinutes > bounds.startMinutes);
});

test("positions a span proportionally inside the window", () => {
  const bounds = { startMinutes: 540, endMinutes: 1080 }; // 09:00-18:00, 540 minutes
  const position = positionWithin({ startMinutes: 540, endMinutes: 630 }, bounds);
  assert.ok(position);
  assert.equal(Math.round(position.topPercent), 0);
  assert.equal(Math.round(position.heightPercent), 17); // 90/540
  const later = positionWithin({ startMinutes: 1035, endMinutes: 1080 }, bounds);
  assert.ok(later);
  assert.equal(Math.round(later.topPercent + later.heightPercent), 100);
});

test("drops spans that fall entirely outside the window", () => {
  const bounds = { startMinutes: 540, endMinutes: 1080 };
  assert.equal(positionWithin({ startMinutes: 60, endMinutes: 120 }, bounds), null);
  assert.equal(clampSpan({ startMinutes: 1200, endMinutes: 1300 }, bounds), null);
});

test("clamps a span that straddles the window edge", () => {
  const bounds = { startMinutes: 540, endMinutes: 1080 };
  assert.deepEqual(clampSpan({ startMinutes: 480, endMinutes: 600 }, bounds), { startMinutes: 540, endMinutes: 600 });
  assert.deepEqual(clampSpan({ startMinutes: 1020, endMinutes: 1200 }, bounds), { startMinutes: 1020, endMinutes: 1080 });
});

test("keeps a very short booking clickable rather than zero-height", () => {
  const position = positionWithin({ startMinutes: 540, endMinutes: 541 }, { startMinutes: 540, endMinutes: 1080 });
  assert.ok(position);
  assert.ok(position.heightPercent >= 1.5);
});

test("emits inclusive time-axis markers", () => {
  const markers = slotMarkers({ startMinutes: 540, endMinutes: 660 }, 60);
  assert.deepEqual(markers, [540, 600, 660]);
});

test("formats minute offsets as a zero-padded clock", () => {
  assert.equal(minutesToLabel(0), "00:00");
  assert.equal(minutesToLabel(9 * 60 + 5), "09:05");
  assert.equal(minutesToLabel(23 * 60 + 59), "23:59");
  assert.equal(minutesToLabel(1440), "00:00");
});
