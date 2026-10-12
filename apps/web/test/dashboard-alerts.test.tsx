import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { OperationalAlerts } from "../src/components/operational-alerts";
import { CAPABILITY_KEYS, type BranchAccess, type CapabilityMap } from "../src/lib/authorization";
import {
  ALERT_DEFINITIONS, ALERT_KEYS, buildAlertReadPlan, loadOperationalAlerts, parseAlertRows, type AlertsState,
} from "../src/lib/dashboard-alerts";
import { DASHBOARD_CARD_DEFAULTS, readDashboardCardSettings } from "../src/lib/dashboard-read-model";

const root = path.resolve(import.meta.dirname, "../../..");
const caps = (...granted: (keyof CapabilityMap)[]): CapabilityMap => {
  const map = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as CapabilityMap;
  for (const key of granted) map[key] = true;
  return map;
};
const everyBranch: BranchAccess = { all: true, ids: new Set() };
const noBranch: BranchAccess = { all: false, ids: new Set() };

type Reply = { data: unknown; error: { code?: string; message: string } | null };
function rpcClient(replies: Record<string, Reply> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    schema: () => ({
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const key = name === "dashboard_operational_alerts" ? `${name}:${(args.p_keys as string[])[0]}` : name;
        return replies[key] ?? { data: [], error: null };
      },
    }),
    from: () => { throw new Error("alerts must read through the RPCs only"); },
  };
  return { calls, client: client as never };
}

test("the read plan removes every alert the caller may not read, and hides the whole section when the card is off", () => {
  assert.deepEqual(Object.values(buildAlertReadPlan(caps(), everyBranch, false)), [false, false, false, false, false]);
  const full = buildAlertReadPlan(caps("booking.read", "finance.read", "order.read", "membership.read"), everyBranch, true);
  assert.deepEqual(full, { unbilled_visits: true, overdue_invoices: true, expiring_packages: true, stale_open_bookings: true, maintenance_problems: true });
  // unbilled visits need order.read as well (the visit register reaches invoices through orders)
  assert.equal(buildAlertReadPlan(caps("booking.read", "finance.read"), everyBranch, false).unbilled_visits, false);
  // branch-owned alerts need a branch grant; packages and maintenance do not
  const noGrant = buildAlertReadPlan(caps("booking.read", "finance.read", "order.read", "membership.read"), noBranch, true);
  assert.deepEqual(noGrant, { unbilled_visits: false, overdue_invoices: false, expiring_packages: true, stale_open_bookings: false, maintenance_problems: true });
  assert.equal(buildAlertReadPlan(caps("booking.read", "finance.read", "order.read", "membership.read"), everyBranch, false).maintenance_problems, false);
  const off = buildAlertReadPlan(caps("booking.read", "finance.read", "order.read", "membership.read"), everyBranch, true, { ...DASHBOARD_CARD_DEFAULTS, operational_alerts: false });
  assert.deepEqual(Object.values(off), [false, false, false, false, false]);
});

test("a hidden section issues no call at all; a denied alert issues none either; the others still load", async () => {
  const hidden = rpcClient();
  const state = await loadOperationalAlerts(hidden.client, caps("booking.read", "finance.read", "order.read", "membership.read"), everyBranch, true, { ...DASHBOARD_CARD_DEFAULTS, operational_alerts: false });
  assert.deepEqual(state, { status: "hidden" });
  assert.equal(hidden.calls.length, 0);

  const none = rpcClient();
  const denied = await loadOperationalAlerts(none.client, caps(), everyBranch, false);
  assert.equal(none.calls.length, 0, "a role with no capability makes no query");
  assert.ok(denied.status === "ready" && denied.alerts.every((alert) => alert.status === "restricted"));

  const financeOnly = rpcClient({
    "dashboard_operational_alerts:overdue_invoices": { data: [{ alert_key: "overdue_invoices", currency: "IDR", item_count: 3, amount: "450000", oldest_at: "2026-09-01T00:00:00Z" }], error: null },
  });
  const partial = await loadOperationalAlerts(financeOnly.client, caps("finance.read"), everyBranch, false);
  assert.deepEqual(financeOnly.calls.map((call) => call.name), ["dashboard_operational_alerts"]);
  assert.deepEqual(financeOnly.calls[0].args, { p_keys: ["overdue_invoices"] }, "no organization identifier is ever sent");
  assert.ok(partial.status === "ready");
  const overdue = partial.alerts.find((alert) => alert.key === "overdue_invoices");
  assert.ok(overdue?.status === "ready" && overdue.count === 3 && overdue.amounts[0].amount === 450000);
  assert.equal(partial.alerts.filter((alert) => alert.status === "restricted").length, 4);
});

test("one failing alert never hides the others, and a failure is never shown as zero", async () => {
  const client = rpcClient({
    "dashboard_operational_alerts:overdue_invoices": { data: null, error: { code: "42501", message: "not_authorized" } },
    "dashboard_operational_alerts:expiring_packages": { data: null, error: { code: "PGRST202", message: "missing" } },
    "dashboard_operational_alerts:stale_open_bookings": { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
    "dashboard_operational_alerts:maintenance_problems": { data: [{ alert_key: "maintenance_problems", currency: null, item_count: 2, amount: null, oldest_at: "2026-10-01T00:00:00Z" }], error: null },
    reconcile_unbilled_visits: { data: [], error: null },
  });
  const state = await loadOperationalAlerts(client.client, caps("booking.read", "finance.read", "order.read", "membership.read"), everyBranch, true);
  assert.ok(state.status === "ready");
  const byKey = Object.fromEntries(state.alerts.map((alert) => [alert.key, alert]));
  assert.equal(byKey.overdue_invoices.status, "restricted");
  assert.equal(byKey.expiring_packages.status, "unavailable");
  assert.equal(byKey.stale_open_bookings.status, "unavailable");
  assert.ok(byKey.stale_open_bookings.status === "unavailable" && !/57014|timeout/.test(byKey.stale_open_bookings.reason), "raw database errors are not shown");
  assert.ok(byKey.maintenance_problems.status === "ready" && byKey.maintenance_problems.count === 2);
  assert.ok(byKey.unbilled_visits.status === "ready" && byKey.unbilled_visits.count === 0 && !byKey.unbilled_visits.capped);
});

test("unbilled visits reuse the reconciliation RPC, count up to 100 and report 100+", async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: `v${i}`, session_source: "booking", branch_id: "b", customer_id: "c", customer_name: "x", visit_at: "2026-10-01T00:00:00Z", description: "d" }));
  const client = rpcClient({ reconcile_unbilled_visits: { data: rows, error: null } });
  const state = await loadOperationalAlerts(client.client, caps("booking.read", "finance.read", "order.read"), everyBranch, false);
  assert.ok(state.status === "ready");
  const unbilled = state.alerts.find((alert) => alert.key === "unbilled_visits");
  assert.ok(unbilled?.status === "ready" && unbilled.count === 100 && unbilled.capped);
  const call = client.calls.find((entry) => entry.name === "reconcile_unbilled_visits");
  assert.equal(call?.args.p_limit, 101);
  const denied = rpcClient({ reconcile_unbilled_visits: { data: null, error: { code: "42501", message: "not_authorized" } } });
  const state2 = await loadOperationalAlerts(denied.client, caps("booking.read", "finance.read", "order.read"), everyBranch, false);
  assert.ok(state2.status === "ready" && state2.alerts.find((alert) => alert.key === "unbilled_visits")?.status === "restricted");
});

test("parseAlertRows keeps currencies apart, ignores other keys and unusable numbers, and reports the explicit zero row", () => {
  const parsed = parseAlertRows("overdue_invoices", [
    { alert_key: "overdue_invoices", currency: "USD", item_count: 1, amount: "50", oldest_at: "2027-01-01T00:00:00Z" },
    { alert_key: "overdue_invoices", currency: "IDR", item_count: 2, amount: 250000, oldest_at: "2026-01-01T00:00:00Z" },
    { alert_key: "stale_open_bookings", currency: null, item_count: 9, amount: null, oldest_at: null },
    { alert_key: "overdue_invoices", currency: "EUR", item_count: "x", amount: "y", oldest_at: null },
  ]);
  assert.equal(parsed.count, 3);
  assert.deepEqual(parsed.amounts.map((entry) => entry.currency), ["IDR", "USD"], "home currency first, never merged");
  assert.equal(parsed.oldestAt, "2026-01-01T00:00:00Z");
  const zero = parseAlertRows("expiring_packages", [{ alert_key: "expiring_packages", currency: null, item_count: 0, amount: null, oldest_at: null }]);
  assert.deepEqual([zero.count, zero.amounts.length, zero.oldestAt], [0, 0, null]);
  assert.equal(parseAlertRows("expiring_packages", null).count, 0);
});

test("every alert links to exactly one internal page, states what it measures, and none claims ROI or profit", () => {
  for (const key of ALERT_KEYS) {
    const definition = ALERT_DEFINITIONS[key];
    assert.match(definition.href, /^\/[a-z/-]+$/, `${key} links to an internal page only`);
    assert.ok(definition.measures.length > 40, `${key} explains what it measures`);
    assert.doesNotMatch(`${definition.title} ${definition.measures}`, /ROI|laba|profit|prediksi|perkiraan skor/i);
  }
  assert.deepEqual(new Set(ALERT_KEYS.map((key) => ALERT_DEFINITIONS[key].href)).size, ALERT_KEYS.length, "no two alerts share a destination");
});

test("component: alerts with items show title, count, per-currency amount, definition and a single link", () => {
  const state: AlertsState = {
    status: "ready",
    alerts: [
      { key: "overdue_invoices", status: "ready", count: 3, capped: false, amounts: [{ currency: "IDR", count: 2, amount: 250000 }, { currency: "USD", count: 1, amount: 50 }], oldestAt: "2020-01-01T00:00:00Z" },
      { key: "expiring_packages", status: "ready", count: 0, capped: false, amounts: [], oldestAt: null },
      { key: "unbilled_visits", status: "ready", count: 100, capped: true, amounts: [], oldestAt: null },
      { key: "stale_open_bookings", status: "restricted", reason: "x" },
      { key: "maintenance_problems", status: "unavailable", reason: "y" },
    ],
  };
  const html = renderToStaticMarkup(<OperationalAlerts state={state} />);
  assert.match(html, /Invoice lewat jatuh tempo: 3 invoice/);
  assert.match(html, /Kunjungan selesai belum ditagih: 100\+ kunjungan/);
  assert.match(html, /Sisa tagihan:[^<]*250\.000[^<]*\(2\)[^<]*·[^<]*50[^<]*\(1\)/, "currencies are listed separately");
  assert.match(html, /href="\/finance"/);
  assert.match(html, /href="\/reconciliation"/);
  assert.doesNotMatch(html, /href="\/programs\/memberships"/, "an alert without items offers no link");
  assert.match(html, /Diperiksa tanpa temuan: Paket\/membership segera berakhir/);
  assert.match(html, /Tidak dimuat karena izin atau cabang peran ini: Booking belum ditutup/);
  assert.match(html, /Belum dapat dimuat saat ini \(bukan berarti nol\): Pekerjaan pemeliharaan bermasalah/);
  assert.match(html, /Apa yang diukur/);
  assert.match(html, /ROI sumber tidak tersedia/);
  assert.doesNotMatch(html, /organization_id|service_role/);
});

test("component: hidden renders nothing; all-zero and nothing-loadable are distinct, honest states", () => {
  assert.equal(renderToStaticMarkup(<OperationalAlerts state={{ status: "hidden" }} />), "");
  const zeros = renderToStaticMarkup(<OperationalAlerts state={{ status: "ready", alerts: [{ key: "overdue_invoices", status: "ready", count: 0, capped: false, amounts: [], oldestAt: null }] }} />);
  assert.match(zeros, /Tidak ada item yang melewati ambang untuk 1 pemeriksaan yang dimuat\. Ini bukan jaminan/);
  const denied = renderToStaticMarkup(<OperationalAlerts state={{ status: "ready", alerts: ALERT_KEYS.map((key) => ({ key, status: "restricted" as const, reason: "x" })) }} />);
  assert.match(denied, /Tidak ada peringatan yang dapat dimuat untuk peran atau cabang ini/);
  assert.doesNotMatch(denied, /Tidak ada item yang melewati ambang/, "denial is never presented as a clean bill of health");
});

test("card setting: absent key is visible, wrong type ignored; the migration allowlist names the key", () => {
  assert.equal(readDashboardCardSettings({}).operational_alerts, true);
  assert.equal(readDashboardCardSettings({ dashboard: { cards: { operational_alerts: false } } }).operational_alerts, false);
  assert.equal(readDashboardCardSettings({ dashboard: { cards: { operational_alerts: "no" } } }).operational_alerts, true);
});

// A source assertion, NOT an RLS test: the behavioural proof is supabase/tests/20261031100000_test_dashboard_operational_alerts.sql.
test("migration shape: definer with empty search_path, explicit grants, tenant filter on every read, no writes", () => {
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261031100000_dashboard_operational_alerts.sql"), "utf8");
  const body = sql.slice(sql.indexOf("create function app.dashboard_operational_alerts"));
  assert.match(body, /security definer set search_path = ''/);
  assert.match(body, /revoke all on function app\.dashboard_operational_alerts\(text\[\]\) from public, anon, authenticated/);
  assert.match(body, /grant execute on function app\.dashboard_operational_alerts\(text\[\]\) to authenticated/);
  assert.ok((body.match(/organization_id = v_org/g) ?? []).length >= 6);
  assert.doesNotMatch(body, /\b(insert into|delete from)\b|\bupdate public\./i);
  assert.match(body, /app\.fn_active_organization\(\)/);
  assert.doesNotMatch(body, /p_org\b|p_organization/, "the organization is never an argument");
});
