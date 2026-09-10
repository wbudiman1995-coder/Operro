import assert from "node:assert/strict";
import test from "node:test";

import {
  addDaysISO,
  formatZonedTime,
  isValidDateISO,
  zoneOffsetMinutes,
  zonedDateTimeToUtc,
  zonedDayISO,
  zonedDaysBetween,
  zonedMinutesFromMidnight,
} from "../src/lib/timezone";

const JAKARTA = "Asia/Jakarta";

test("resolves a fixed positive offset", () => {
  assert.equal(zoneOffsetMinutes(new Date("2026-08-02T00:00:00Z"), JAKARTA), 420);
});

test("resolves a negative offset", () => {
  assert.equal(zoneOffsetMinutes(new Date("2026-08-02T12:00:00Z"), "America/New_York"), -240);
});

test("maps an instant to its branch-local calendar day", () => {
  // 17:00Z is already the next day in Jakarta (UTC+7).
  assert.equal(zonedDayISO(new Date("2026-08-02T17:00:00Z"), JAKARTA), "2026-08-03");
  assert.equal(zonedDayISO(new Date("2026-08-02T16:59:59Z"), JAKARTA), "2026-08-02");
});

test("reads local minutes from midnight, not UTC minutes", () => {
  assert.equal(zonedMinutesFromMidnight(new Date("2026-08-02T02:30:00Z"), JAKARTA), 9 * 60 + 30);
});

test("round-trips a local date and minute offset through UTC", () => {
  const instant = zonedDateTimeToUtc("2026-08-02", 9 * 60 + 30, JAKARTA);
  assert.equal(instant.toISOString(), "2026-08-02T02:30:00.000Z");
  assert.equal(zonedDayISO(instant, JAKARTA), "2026-08-02");
  assert.equal(zonedMinutesFromMidnight(instant, JAKARTA), 9 * 60 + 30);
});

test("local midnight is not UTC midnight", () => {
  assert.equal(zonedDateTimeToUtc("2026-08-02", 0, JAKARTA).toISOString(), "2026-08-01T17:00:00.000Z");
});

test("survives a DST transition zone without shifting the local wall clock", () => {
  // London is UTC+1 in July and UTC+0 in January; both must report 09:00 locally.
  const summer = zonedDateTimeToUtc("2026-07-15", 9 * 60, "Europe/London");
  const winter = zonedDateTimeToUtc("2026-01-15", 9 * 60, "Europe/London");
  assert.equal(formatZonedTime(summer, "Europe/London"), "09:00");
  assert.equal(formatZonedTime(winter, "Europe/London"), "09:00");
  assert.equal(summer.toISOString(), "2026-07-15T08:00:00.000Z");
  assert.equal(winter.toISOString(), "2026-01-15T09:00:00.000Z");
});

test("counts whole local days across a UTC day boundary", () => {
  // These two instants are 1 hour apart but sit on different Jakarta days.
  const from = new Date("2026-08-02T16:30:00Z");
  const to = new Date("2026-08-02T17:30:00Z");
  assert.equal(zonedDaysBetween(from, to, JAKARTA), 1);
  assert.equal(zonedDaysBetween(from, to, "UTC"), 0);
});

test("shifts ISO dates across month and year ends", () => {
  assert.equal(addDaysISO("2026-08-31", 1), "2026-09-01");
  assert.equal(addDaysISO("2026-01-01", -1), "2025-12-31");
  assert.equal(addDaysISO("2028-02-28", 1), "2028-02-29");
});

test("guards malformed date input", () => {
  assert.equal(isValidDateISO("2026-08-02"), true);
  assert.equal(isValidDateISO("2026-02-30"), false);
  assert.equal(isValidDateISO("2026-8-2"), false);
  assert.equal(isValidDateISO(""), false);
  assert.equal(isValidDateISO(null), false);
});
