import assert from "node:assert/strict";
import test from "node:test";

import { formatDashboardRange, inclusiveDays, MAX_DASHBOARD_PERIOD_DAYS, resolveDashboardPeriod } from "../src/lib/dashboard-period";

const JKT = "Asia/Jakarta";
const noon = new Date("2026-10-10T05:00:00Z"); // 12:00 in Jakarta, 10 Oct 2026

function ok(input: Parameters<typeof resolveDashboardPeriod>[0], now = noon, zone = JKT) {
  const result = resolveDashboardPeriod(input, now, zone);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.period;
}
function refused(input: Parameters<typeof resolveDashboardPeriod>[0], pattern: RegExp, now = noon) {
  const result = resolveDashboardPeriod(input, now, JKT);
  assert.equal(result.ok, false, "expected a refusal");
  if (!result.ok) {
    assert.match(result.message, pattern);
    // A refusal always carries the safe default so the page can still render.
    assert.deepEqual(result.period.current, { from: "2026-10-10", to: "2026-10-10" });
  }
}

test("no selection keeps the existing default: today against yesterday", () => {
  for (const input of [{}, { period: "" }, { period: "today" }]) {
    const period = ok(input);
    assert.deepEqual(period.current, { from: "2026-10-10", to: "2026-10-10" });
    assert.deepEqual(period.previous, { from: "2026-10-09", to: "2026-10-09" });
    assert.equal(period.days, 1);
  }
});

test("'today' follows the Jakarta calendar, not UTC or the server clock", () => {
  // 17:30Z on 9 Oct is already 00:30 on 10 Oct in Jakarta.
  assert.equal(ok({}, new Date("2026-10-09T17:30:00Z")).today, "2026-10-10");
  assert.equal(ok({}, new Date("2026-10-09T16:59:00Z")).today, "2026-10-09");
  // The same instant is a different day in another zone: the zone argument decides.
  assert.equal(ok({}, new Date("2026-10-09T17:30:00Z"), "UTC").today, "2026-10-09");
});

test("presets are inclusive and compared with the immediately preceding equal-length range", () => {
  const cases: Array<[string, string, string, string, string, number]> = [
    ["7d", "2026-10-04", "2026-10-10", "2026-09-27", "2026-10-03", 7],
    ["30d", "2026-09-11", "2026-10-10", "2026-08-12", "2026-09-10", 30],
    ["month", "2026-10-01", "2026-10-10", "2026-09-21", "2026-09-30", 10],
    ["last_month", "2026-09-01", "2026-09-30", "2026-08-02", "2026-08-31", 30],
  ];
  for (const [preset, from, to, prevFrom, prevTo, days] of cases) {
    const period = ok({ period: preset });
    assert.deepEqual([period.current.from, period.current.to, period.previous.from, period.previous.to, period.days], [from, to, prevFrom, prevTo, days], preset);
  }
});

test("month arithmetic crosses year ends and leap days", () => {
  const january = ok({ period: "last_month" }, new Date("2026-01-05T05:00:00Z"));
  assert.deepEqual([january.current.from, january.current.to, january.previous.from, january.previous.to], ["2025-12-01", "2025-12-31", "2025-10-31", "2025-11-30"]);
  const leap = ok({ period: "last_month" }, new Date("2028-03-10T05:00:00Z"));
  assert.deepEqual([leap.current.from, leap.current.to, leap.days, leap.previous.from, leap.previous.to], ["2028-02-01", "2028-02-29", 29, "2028-01-03", "2028-01-31"]);
  const firstDay = ok({ period: "month" }, new Date("2026-11-01T05:00:00Z"));
  assert.deepEqual([firstDay.current.from, firstDay.current.to, firstDay.previous.from], ["2026-11-01", "2026-11-01", "2026-10-31"]);
});

test("every accepted selection has an adjacent previous range of equal length", () => {
  const nows = ["2026-01-01T00:00:00Z", "2026-02-28T20:00:00Z", "2028-02-29T05:00:00Z", "2026-12-31T23:59:00Z"].map((value) => new Date(value));
  for (const now of nows) {
    for (const input of [{ period: "today" }, { period: "7d" }, { period: "30d" }, { period: "month" }, { period: "last_month" }]) {
      const period = ok(input, now);
      assert.equal(inclusiveDays(period.previous.from, period.previous.to), period.days);
      assert.equal(period.previous.to, new Date(Date.parse(`${period.current.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
      assert.ok(period.current.to <= period.today);
    }
  }
});

test("custom ranges are inclusive and bounded at 366 days", () => {
  const range = ok({ period: "custom", from: "2026-09-20", to: "2026-10-05" });
  assert.deepEqual([range.preset, range.days, range.previous.from, range.previous.to], ["custom", 16, "2026-09-04", "2026-09-19"]);
  assert.equal(ok({ period: "custom", from: "2026-10-10", to: "2026-10-10" }).days, 1);
  const longest = ok({ period: "custom", from: "2025-10-10", to: "2026-10-10" });
  assert.equal(longest.days, MAX_DASHBOARD_PERIOD_DAYS);
  refused({ period: "custom", from: "2025-10-09", to: "2026-10-10" }, /maksimal 366 hari/);
});

test("malformed, inverted, future and unknown input is refused safely with the default", () => {
  refused({ period: "custom", from: "2026-02-30", to: "2026-03-01" }, /YYYY-MM-DD/);
  refused({ period: "custom", from: "10/10/2026", to: "2026-10-10" }, /YYYY-MM-DD/);
  refused({ period: "custom", from: "2026-10-01" }, /YYYY-MM-DD/);
  refused({ period: "custom" }, /YYYY-MM-DD/);
  refused({ period: "custom", from: ["2026-10-01", "2026-10-02"], to: "2026-10-05" }, /YYYY-MM-DD/);
  refused({ period: "custom", from: "2026-10-09", to: "2026-10-01" }, /tidak boleh setelah/);
  refused({ period: "custom", from: "2026-10-11", to: "2026-10-20" }, /masa depan/);
  refused({ period: "custom", from: "2026-10-01", to: "2026-10-11" }, /melewati hari ini/);
  refused({ period: "custom", from: "2000-01-10", to: "2000-02-20" }, /terlalu jauh/);
  refused({ period: "yesterday" }, /tidak dikenal/);
  refused({ period: ["7d", "30d"] }, /tidak dikenal/);
  refused({ period: "__proto__" }, /tidak dikenal/);
});

test("stray from/to values are ignored for presets", () => {
  assert.deepEqual(ok({ period: "7d", from: "garbage", to: "2099-01-01" }).current, { from: "2026-10-04", to: "2026-10-10" });
});

test("labels are Indonesian and name both ranges", () => {
  assert.equal(formatDashboardRange({ from: "2026-10-01", to: "2026-10-10" }), "1–10 Okt 2026");
  assert.equal(formatDashboardRange({ from: "2026-09-28", to: "2026-10-03" }), "28 Sep 2026 – 3 Okt 2026");
  assert.equal(formatDashboardRange({ from: "2026-10-10", to: "2026-10-10" }), "10 Okt 2026");
  const period = ok({ period: "7d" });
  assert.equal(period.label, "7 hari terakhir · 4–10 Okt 2026");
  assert.equal(period.comparisonLabel, "Dibanding 7 hari sebelumnya · 27 Sep 2026 – 3 Okt 2026");
  assert.equal(ok({}).comparisonLabel, "Dibanding hari sebelumnya · 9 Okt 2026");
});
