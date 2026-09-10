import assert from "node:assert/strict";
import test from "node:test";

import { resolveMinuteBounds, splitIntoDaySegments } from "../src/lib/schedule-layout";

const JAKARTA = "Asia/Jakarta";

/** Jakarta is UTC+7, so local midnight on 2026-08-02 is 2026-08-01T17:00:00Z. */
const DAY = "2026-08-02";
const NEXT_DAY = "2026-08-03";

test("places a same-day booking on exactly one day", () => {
  const segments = splitIntoDaySegments(
    new Date("2026-08-02T02:00:00Z"), // 09:00 Jakarta
    new Date("2026-08-02T03:30:00Z"), // 10:30 Jakarta
    [DAY],
    JAKARTA,
  );
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], { dayISO: DAY, startMinutes: 540, endMinutes: 630, continuesBefore: false, continuesAfter: false });
});

test("a booking starting before the window is still placed inside it", () => {
  // This is correction 6: the query now uses an overlap condition, so this row reaches
  // the client. It must render on the day it occupies, clipped at local midnight.
  const segments = splitIntoDaySegments(
    new Date("2026-08-01T15:00:00Z"), // 22:00 Jakarta on 2026-08-01, before the window
    new Date("2026-08-01T19:00:00Z"), // 02:00 Jakarta on 2026-08-02, inside the window
    [DAY],
    JAKARTA,
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0].dayISO, DAY);
  assert.equal(segments[0].startMinutes, 0);
  assert.equal(segments[0].endMinutes, 120);
  assert.equal(segments[0].continuesBefore, true);
  assert.equal(segments[0].continuesAfter, false);
});

test("a booking crossing local midnight appears on both days", () => {
  const segments = splitIntoDaySegments(
    new Date("2026-08-02T15:00:00Z"), // 22:00 Jakarta on 08-02
    new Date("2026-08-02T18:00:00Z"), // 01:00 Jakarta on 08-03
    [DAY, NEXT_DAY],
    JAKARTA,
  );
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { dayISO: DAY, startMinutes: 1320, endMinutes: 1440, continuesBefore: false, continuesAfter: true });
  assert.deepEqual(segments[1], { dayISO: NEXT_DAY, startMinutes: 0, endMinutes: 60, continuesBefore: true, continuesAfter: false });
});

test("a multi-day occupancy fills every intermediate day", () => {
  const segments = splitIntoDaySegments(
    new Date("2026-08-01T17:00:00Z"), // 00:00 Jakarta 08-02
    new Date("2026-08-04T17:00:00Z"), // 00:00 Jakarta 08-05
    [DAY, NEXT_DAY, "2026-08-04"],
    JAKARTA,
  );
  assert.equal(segments.length, 3);
  for (const segment of segments) {
    assert.equal(segment.startMinutes, 0);
    assert.equal(segment.endMinutes, 1440);
  }
  assert.equal(segments[0].continuesBefore, false);
  assert.equal(segments[1].continuesBefore, true);
  assert.equal(segments[1].continuesAfter, true);
  // The range ends exactly at this day's local midnight, so it does not continue past it.
  assert.equal(segments[2].continuesAfter, false);
  assert.equal(segments[2].continuesBefore, true);
});

test("returns no segments when the range misses every requested day", () => {
  const segments = splitIntoDaySegments(
    new Date("2026-07-01T02:00:00Z"),
    new Date("2026-07-01T03:00:00Z"),
    [DAY],
    JAKARTA,
  );
  assert.deepEqual(segments, []);
});

test("rejects a zero-length or inverted range", () => {
  const instant = new Date("2026-08-02T02:00:00Z");
  assert.deepEqual(splitIntoDaySegments(instant, instant, [DAY], JAKARTA), []);
  assert.deepEqual(splitIntoDaySegments(new Date("2026-08-02T03:00:00Z"), instant, [DAY], JAKARTA), []);
});

test("segment minutes are branch-local, not UTC", () => {
  const segments = splitIntoDaySegments(
    new Date("2026-08-02T02:00:00Z"),
    new Date("2026-08-02T03:00:00Z"),
    [DAY],
    JAKARTA,
  );
  // 02:00Z is 09:00 Jakarta. A UTC reading would report 120 minutes past midnight.
  assert.equal(segments[0].startMinutes, 540);
  assert.notEqual(segments[0].startMinutes, 120);
});

test("bounds derive from segments, so a filtered-out groomer cannot stretch the axis", () => {
  // Correction 4: bounds are computed from the same segments that render. With only the
  // 09:00-10:00 segment present, the axis must not widen to a 06:00 start.
  const visible = splitIntoDaySegments(new Date("2026-08-02T02:00:00Z"), new Date("2026-08-02T03:00:00Z"), [DAY], JAKARTA);
  const bounds = resolveMinuteBounds(visible);
  assert.equal(bounds.startMinutes, 8 * 60 + 30);

  const withEarly = [
    ...visible,
    ...splitIntoDaySegments(new Date("2026-08-01T23:00:00Z"), new Date("2026-08-02T00:00:00Z"), [DAY], JAKARTA),
  ];
  assert.equal(resolveMinuteBounds(withEarly).startMinutes, 6 * 60);
});
