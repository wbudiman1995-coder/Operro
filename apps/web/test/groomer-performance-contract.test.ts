import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const data = fs.readFileSync(path.join(root, "apps/web/src/lib/pilot-data.ts"), "utf8");
const page = fs.readFileSync(path.join(root, "apps/web/src/app/leaderboard/page.tsx"), "utf8");
const detail = fs.readFileSync(path.join(root, "apps/web/src/app/leaderboard/[resourceId]/page.tsx"), "utf8");

test("performance keeps invoice revenue unsplit and uses attributable activity", () => {
  assert.match(data, /Revenue-per-groomer is deliberately not shown/);
  assert.match(data, /grooming_job_pets/);
  assert.match(data, /commission_entries/);
  assert.doesNotMatch(data.slice(data.indexOf("export async function loadLeaderboardWorkspace"), data.indexOf("export interface FollowupGroup")), /from\("invoices"\)/);
});

test("retention and duration come from bounded booking history and timeline actuals", () => {
  assert.match(data, /leaderboard_historical_bookings/);
  assert.match(data, /\.in\("customer_id", currentCustomerIds\)/);
  assert.match(data, /booking\.status_changed/);
  assert.match(data, /booking\.completed/);
  assert.match(data, /averageDurationMinutes/);
});

test("documentation and complaint metrics use real evidence and tagged task records", () => {
  assert.match(data, /categories\.has\("before"\).*categories\.has\("after"\)/);
  assert.match(data, /contains\("metadata", \{ category: "complaint" \}\)/);
  assert.match(page, /Dokumentasi/);
  assert.match(page, /Keluhan/);
});

test("performance cycles can move backward and forward by month", () => {
  assert.match(page, /Sebelumnya/);
  assert.match(page, /Berikutnya/);
  assert.match(page, /searchParams/);
});

test("leaderboard links each groomer to a visit-level evidence drill-down", () => {
  assert.match(page, /\/leaderboard\/\$\{row\.resourceId\}/);
  assert.match(data, /loadGroomerPerformanceDetail/);
  assert.match(detail, /Visit yang dihitung/);
  assert.match(detail, /Dokumentasi belum lengkap/);
});
