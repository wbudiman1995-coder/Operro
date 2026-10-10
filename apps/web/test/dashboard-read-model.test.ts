import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CAPABILITY_KEYS, type CapabilityMap } from "../src/lib/authorization";
import { loadDashboardData } from "../src/lib/pilot-data";
import { buildDashboardReadPlan, DASHBOARD_CARD_DEFAULTS, DASHBOARD_CARD_KEYS, DASHBOARD_METRIC_CARD_KEYS, dashboardDayRanges, readDashboardCardSettings, sumRecordedAmounts } from "../src/lib/dashboard-read-model";

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
  assert.deepEqual(denied, { bookingMetrics: false, upcomingBookings: false, revenueMetrics: false, customerMetrics: false, taskMetrics: false, branchIds: ["branch-a"] });

  const financeOnly = buildDashboardReadPlan(capabilities("finance.read"), { all: false, ids: new Set(["branch-b"]) });
  assert.equal(financeOnly.revenueMetrics, true);
  assert.equal(financeOnly.bookingMetrics, false);
  assert.equal(financeOnly.upcomingBookings, false);
  assert.equal(financeOnly.customerMetrics, false);
  assert.equal(financeOnly.taskMetrics, false);
});

test("branch scope preserves only server-resolved grants and distinguishes all branches", () => {
  const scoped = buildDashboardReadPlan(capabilities("booking.read", "task.manage"), { all: false, ids: new Set(["branch-z", "branch-a"]) });
  assert.deepEqual(scoped.branchIds, ["branch-a", "branch-z"]);
  assert.equal(scoped.bookingMetrics, true);
  assert.equal(scoped.upcomingBookings, true);
  assert.equal(scoped.taskMetrics, true);

  const all = buildDashboardReadPlan(capabilities("booking.read"), { all: true, ids: new Set(["ignored"]) });
  assert.equal(all.branchIds, null);

  const none = buildDashboardReadPlan(capabilities("booking.read"), { all: false, ids: new Set() });
  assert.deepEqual(none.branchIds, []);
});

test("card settings default safely and accept only known booleans", () => {
  assert.deepEqual(readDashboardCardSettings(null), DASHBOARD_CARD_DEFAULTS);
  assert.deepEqual(readDashboardCardSettings({ dashboard: "broken" }), DASHBOARD_CARD_DEFAULTS);
  assert.deepEqual(readDashboardCardSettings({ dashboard: { cards: [] } }), DASHBOARD_CARD_DEFAULTS);
  assert.deepEqual(readDashboardCardSettings({ dashboard: { cards: { booking_today: false, revenue_today: "false", unknown: false } } }), {
    ...DASHBOARD_CARD_DEFAULTS,
    booking_today: false,
  });
});

test("hidden booking KPI does not suppress upcoming bookings or widen access", () => {
  const caps = capabilities("booking.read", "finance.read", "customer.read", "task.manage");
  const plan = buildDashboardReadPlan(caps, { all: false, ids: new Set(["branch-b", "branch-a"]) }, {
    ...DASHBOARD_CARD_DEFAULTS, booking_today: false, revenue_today: false, active_customers: false, open_tasks: false,
  });
  assert.deepEqual(plan, {
    bookingMetrics: false, upcomingBookings: true, revenueMetrics: false, customerMetrics: false, taskMetrics: false,
    branchIds: ["branch-a", "branch-b"],
  });
  const denied = buildDashboardReadPlan(capabilities(), { all: false, ids: new Set() });
  assert.equal(denied.upcomingBookings, false);
  assert.deepEqual(denied.branchIds, []);
});

test("each hidden card suppresses only its own metric read", () => {
  const caps = capabilities("booking.read", "finance.read", "customer.read", "task.manage");
  const branch = { all: true, ids: new Set<string>() };
  const domains = {
    booking_today: "bookingMetrics",
    revenue_today: "revenueMetrics",
    active_customers: "customerMetrics",
    open_tasks: "taskMetrics",
  } as const;
  for (const [card, domain] of Object.entries(domains) as Array<[keyof typeof domains, typeof domains[keyof typeof domains]]>) {
    const plan = buildDashboardReadPlan(caps, branch, { ...DASHBOARD_CARD_DEFAULTS, [card]: false });
    for (const metric of Object.values(domains)) assert.equal(plan[metric], metric !== domain, `${card} changed ${metric}`);
    assert.equal(plan.upcomingBookings, true);
  }
});

test("dashboard loader keeps the upcoming read independent of booking metric visibility", () => {
  assert.match(dashboardLoader, /plan\.upcomingBookings && hasReadableBranch \? upcomingQuery/);
  assert.match(dashboardLoader, /plan\.bookingMetrics && hasReadableBranch \? bookingCurrentQuery/);
  assert.doesNotMatch(dashboardLoader, /plan\.bookings\b/);
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

test("dashboard settings write: session org equality check, settings.manage, complete allowlist via the guarded RPC", () => {
  const action = fs.readFileSync(path.join(root, "apps/web/src/app/dashboard/actions.ts"), "utf8");
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261028110000_dashboard_card_settings.sql"), "utf8");
  assert.match(action, /workspace\.activeOrganization\.id !== expectedOrganizationId/);
  assert.match(action, /capabilities\["settings\.manage"\]/);
  assert.match(action, /for \(const key of DASHBOARD_CARD_KEYS\)/);
  assert.match(action, /rpc\("update_dashboard_card_settings", \{ p_cards: cards \}\)/);
  assert.doesNotMatch(action, /from\("organizations"\)/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /has_permission\('settings\.manage'\)/);
  assert.match(migration, /revoke all on function app\.update_dashboard_card_settings\(jsonb\) from public, anon, authenticated/);
  for (const key of DASHBOARD_METRIC_CARD_KEYS) assert.ok(migration.includes(`'${key}'`), key);
  const latest = fs.readFileSync(path.join(root, "supabase/migrations/20261030100000_performance_dashboard.sql"), "utf8");
  for (const key of DASHBOARD_CARD_KEYS) assert.ok(latest.includes(`'${key}'`), `${key} must be in the replacement allowlist`);
  assert.match(latest, /set search_path = ''/);
  assert.match(latest, /revoke all on function app\.update_dashboard_card_settings\(jsonb\) from public, anon, authenticated/);
});

/** Query builders are lazy: a table is "read" only when its builder is awaited. Record exactly those. */
function recordingClient() {
  const executed: string[] = [];
  const builder = (table: string): unknown => new Proxy(function () {}, {
    get: (_target, name) => name === "then"
      ? (resolve: (value: unknown) => void) => { executed.push(table); resolve({ data: [], count: 0, error: null }); }
      : () => builder(table),
  });
  return { executed, client: { from: (table: string) => builder(table) } as never };
}
const allBranches = { all: true, ids: new Set<string>() };

test("hidden cards do not execute their underlying queries (behavioral, via a recording client)", async () => {
  const caps = capabilities("booking.read", "finance.read", "customer.read", "task.manage");
  const allHidden = { ...DASHBOARD_CARD_DEFAULTS, booking_today: false, revenue_today: false, active_customers: false, open_tasks: false };

  const none = recordingClient();
  const hidden = await loadDashboardData(none.client, "org", caps, allBranches, "Asia/Jakarta", allHidden);
  assert.deepEqual(none.executed, ["bookings"], "only the upcoming-bookings list may read when every card is hidden");
  assert.deepEqual([hidden.bookingToday, hidden.revenueToday, hidden.activeCustomers, hidden.openTasks], [null, null, null, null]);

  const all = recordingClient();
  await loadDashboardData(all.client, "org", caps, allBranches, "Asia/Jakarta", DASHBOARD_CARD_DEFAULTS);
  assert.deepEqual([...all.executed].sort(), ["bookings", "bookings", "bookings", "customers", "payments", "payments", "tasks", "visit_manual_billing", "visit_manual_billing"]);

  const revenueOnly = recordingClient();
  await loadDashboardData(revenueOnly.client, "org", caps, allBranches, "Asia/Jakarta", { ...allHidden, revenue_today: true });
  assert.deepEqual([...revenueOnly.executed].sort(), ["bookings", "payments", "payments", "visit_manual_billing", "visit_manual_billing"]);
});

test("a visible card without its capability stays restricted (null), never a misleading zero, and reads nothing", async () => {
  const noCaps = recordingClient();
  const restricted = await loadDashboardData(noCaps.client, "org", capabilities(), allBranches, "Asia/Jakarta", DASHBOARD_CARD_DEFAULTS);
  assert.deepEqual(noCaps.executed, []);
  assert.deepEqual([restricted.bookingToday, restricted.revenueToday, restricted.activeCustomers, restricted.openTasks], [null, null, null, null]);

  const noBranch = recordingClient();
  const empty = await loadDashboardData(noBranch.client, "org", capabilities("booking.read", "finance.read", "customer.read", "task.manage"), { all: false, ids: new Set<string>() }, "Asia/Jakarta", DASHBOARD_CARD_DEFAULTS);
  assert.deepEqual(noBranch.executed, ["customers"], "only the organization-wide customer count may read without a branch grant");
  assert.deepEqual([empty.bookingToday, empty.revenueToday, empty.openTasks], [null, null, null]);
  assert.equal(empty.hasAccessibleBranch, false);
});
