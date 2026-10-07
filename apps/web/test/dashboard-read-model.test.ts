import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CAPABILITY_KEYS, type CapabilityMap } from "../src/lib/authorization";
import { buildDashboardReadPlan, dashboardDayRanges, sumRecordedAmounts } from "../src/lib/dashboard-read-model";

const root = path.resolve(import.meta.dirname, "../../..");
const pilotData = fs.readFileSync(path.join(root, "apps/web/src/lib/pilot-data.ts"), "utf8");
const dashboardLoader = pilotData.slice(pilotData.indexOf("export async function loadDashboardData"), pilotData.indexOf("export interface CustomerWorkspace"));

function capabilities(...granted: (keyof CapabilityMap)[]): CapabilityMap {
  const map = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as CapabilityMap;
  for (const key of granted) map[key] = true;
  return map;
}

test("capability denial removes the corresponding dashboard read domains", () => {
  const denied = buildDashboardReadPlan(capabilities(), { all: false, ids: new Set(["branch-a"]) });
  assert.deepEqual(denied, { bookings: false, revenue: false, customers: false, tasks: false, branchIds: ["branch-a"] });

  const financeOnly = buildDashboardReadPlan(capabilities("finance.read"), { all: false, ids: new Set(["branch-b"]) });
  assert.equal(financeOnly.revenue, true);
  assert.equal(financeOnly.bookings, false);
  assert.equal(financeOnly.customers, false);
  assert.equal(financeOnly.tasks, false);
});

test("branch scope preserves only server-resolved grants and distinguishes all branches", () => {
  const scoped = buildDashboardReadPlan(capabilities("booking.read", "task.manage"), { all: false, ids: new Set(["branch-z", "branch-a"]) });
  assert.deepEqual(scoped.branchIds, ["branch-a", "branch-z"]);
  assert.equal(scoped.bookings, true);
  assert.equal(scoped.tasks, true);

  const all = buildDashboardReadPlan(capabilities("booking.read"), { all: true, ids: new Set(["ignored"]) });
  assert.equal(all.branchIds, null);

  const none = buildDashboardReadPlan(capabilities("booking.read"), { all: false, ids: new Set() });
  assert.deepEqual(none.branchIds, []);
});

test("dashboard queries retain tenant and branch filters", () => {
  for (const table of ["bookings", "customers", "tasks", "payments", "visit_manual_billing"]) {
    const tableQueries = dashboardLoader.split(`from("${table}")`).slice(1);
    assert.ok(tableQueries.length > 0, `expected a ${table} query`);
    for (const query of tableQueries) {
      assert.match(query.split(";")[0] ?? "", /\.eq\("organization_id", organizationId\)/, `${table} must be tenant scoped`);
    }
  }
  assert.match(dashboardLoader, /\.in\("branch_id", plan\.branchIds\)/, "branch-owned rows must use the resolved grant list");
});

test("recorded revenue is the sum of persisted valid amounts only", () => {
  assert.equal(sumRecordedAmounts([{ amount: "125000.50" }, { amount: 75000 }, { amount: null }, { amount: "invalid" }, { amount: -1 }]), 200000.5);
  assert.doesNotMatch(dashboardLoader, /price_snapshot|invoice_lines|estimated|forecast/i, "dashboard revenue must not infer values from catalog, invoices, or forecasts");
});

test("comparison periods use the named business time zone", () => {
  assert.deepEqual(dashboardDayRanges(new Date("2026-10-07T12:00:00.000Z"), "Asia/Jakarta"), {
    previousStart: "2026-10-05T17:00:00.000Z",
    currentStart: "2026-10-06T17:00:00.000Z",
    currentEnd: "2026-10-07T17:00:00.000Z",
    upcomingEnd: "2026-10-13T17:00:00.000Z",
  });
});
