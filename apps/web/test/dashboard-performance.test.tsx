import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { PerformanceDashboard } from "../src/components/performance-dashboard";
import { CAPABILITY_KEYS, type BranchAccess, type CapabilityMap } from "../src/lib/authorization";
import {
  describeChange, formatMoney, loadDashboardPerformance, parseFinanceRows, parseOperationsRows, parseSourceRows,
  type DashboardPerformance,
} from "../src/lib/dashboard-performance";
import { resolveDashboardPeriod } from "../src/lib/dashboard-period";
import { buildPerformanceReadPlan, DASHBOARD_CARD_DEFAULTS, readDashboardCardSettings } from "../src/lib/dashboard-read-model";

const root = path.resolve(import.meta.dirname, "../../..");
const caps = (...granted: (keyof CapabilityMap)[]): CapabilityMap => {
  const map = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as CapabilityMap;
  for (const key of granted) map[key] = true;
  return map;
};
const everyBranch: BranchAccess = { all: true, ids: new Set() };
const oneBranch: BranchAccess = { all: false, ids: new Set(["branch-a"]) };
const noBranch: BranchAccess = { all: false, ids: new Set() };
const period = (() => { const r = resolveDashboardPeriod({ period: "month" }, new Date("2026-10-10T05:00:00Z"), "Asia/Jakarta"); assert.ok(r.ok); return r.period; })();

type Reply = { data: unknown; error: { code?: string; message: string } | null };
function rpcClient(replies: Record<string, Reply | (() => Reply)> = {}) {
  const calls: Array<{ schema: string; name: string; args: Record<string, unknown> }> = [];
  const client = {
    schema: (schema: string) => ({
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ schema, name, args });
        const reply = replies[name];
        return typeof reply === "function" ? reply() : reply ?? { data: [], error: null };
      },
    }),
    from: () => { throw new Error("performance cards must read through the aggregates only"); },
  };
  return { calls, client: client as never };
}

test("the read plan removes every domain the caller may not read, and a hidden card", () => {
  assert.deepEqual(buildPerformanceReadPlan(caps(), everyBranch), { operations: false, finance: false, sources: false, sourcesBooking: false, sourcesFinance: false });
  const owner = buildPerformanceReadPlan(caps("booking.read", "finance.read", "customer.read"), everyBranch);
  assert.deepEqual(owner, { operations: true, finance: true, sources: true, sourcesBooking: true, sourcesFinance: true });
  // Customers have no branch: a branch-restricted caller never gets the source breakdown.
  const restricted = buildPerformanceReadPlan(caps("booking.read", "finance.read", "customer.manage"), oneBranch);
  assert.deepEqual([restricted.operations, restricted.finance, restricted.sources], [true, true, false]);
  assert.deepEqual(buildPerformanceReadPlan(caps("booking.read", "finance.read", "customer.read"), noBranch).operations, false);
  const off = buildPerformanceReadPlan(caps("booking.read", "finance.read", "customer.read"), everyBranch, { ...DASHBOARD_CARD_DEFAULTS, performance_finance: false });
  assert.deepEqual([off.operations, off.finance, off.sources], [true, false, true]);
});

test("card visibility falls back safely: absent new keys are visible, wrong types are ignored, unknown keys are dropped", () => {
  assert.deepEqual(readDashboardCardSettings({ dashboard: { cards: { booking_today: false } } }), { ...DASHBOARD_CARD_DEFAULTS, booking_today: false });
  assert.deepEqual(
    readDashboardCardSettings({ dashboard: { cards: { performance_finance: false, performance_sources: "no", performance_operations: 0, hacked: false } } }),
    { ...DASHBOARD_CARD_DEFAULTS, performance_finance: false },
  );
  assert.deepEqual(readDashboardCardSettings({ dashboard: { cards: ["performance_finance"] } }), DASHBOARD_CARD_DEFAULTS);
});

test("an owner reads each aggregate once, with only validated period arguments and no organization identifier", async () => {
  const { calls, client } = rpcClient();
  const result = await loadDashboardPerformance(client, caps("booking.read", "finance.read", "customer.read"), everyBranch, period, "Asia/Jakarta");
  assert.deepEqual(calls.map((call) => call.name).sort(), ["dashboard_finance_performance", "dashboard_operations_performance", "dashboard_source_performance"]);
  for (const call of calls) {
    assert.equal(call.schema, "app");
    assert.deepEqual(Object.keys(call.args).sort(), ["p_from", "p_prev_from", "p_prev_to", "p_timezone", "p_to"]);
    assert.deepEqual(call.args, { p_from: "2026-10-01", p_to: "2026-10-10", p_prev_from: "2026-09-21", p_prev_to: "2026-09-30", p_timezone: "Asia/Jakarta" });
  }
  assert.deepEqual([result.operations.status, result.finance.status, result.sources.status], ["ready", "ready", "ready"]);
});

test("finance cards do not load without finance.read, and no call is issued for any denied domain", async () => {
  const none = rpcClient();
  const denied = await loadDashboardPerformance(none.client, caps(), everyBranch, period, "Asia/Jakarta");
  assert.deepEqual(none.calls, []);
  assert.deepEqual([denied.operations.status, denied.finance.status, denied.sources.status], ["restricted", "restricted", "restricted"]);

  const noFinance = rpcClient();
  const result = await loadDashboardPerformance(noFinance.client, caps("booking.read", "customer.read"), everyBranch, period, "Asia/Jakarta");
  assert.deepEqual(noFinance.calls.map((call) => call.name).sort(), ["dashboard_operations_performance", "dashboard_source_performance"]);
  assert.equal(result.finance.status, "restricted");
  assert.match(result.finance.status === "restricted" ? result.finance.reason : "", /finance\.read/);
  const sources = result.sources.status === "ready" ? result.sources.data : null;
  assert.ok(sources);
  assert.equal(sources.financeColumnAvailable, false);
});

test("a branch-restricted caller reads operations and finance but never the customer-wide source breakdown", async () => {
  const { calls, client } = rpcClient();
  const result = await loadDashboardPerformance(client, caps("booking.read", "finance.read", "customer.read"), oneBranch, period, "Asia/Jakarta");
  assert.deepEqual(calls.map((call) => call.name).sort(), ["dashboard_finance_performance", "dashboard_operations_performance"]);
  assert.equal(result.sources.status, "restricted");
  const none = rpcClient();
  const empty = await loadDashboardPerformance(none.client, caps("booking.read", "finance.read", "customer.read"), noBranch, period, "Asia/Jakarta");
  assert.deepEqual(none.calls, []);
  assert.deepEqual([empty.operations.status, empty.finance.status, empty.sources.status], ["restricted", "restricted", "restricted"]);
});

test("hidden cards issue no query", async () => {
  const { calls, client } = rpcClient();
  const hidden = { ...DASHBOARD_CARD_DEFAULTS, performance_operations: false, performance_finance: false, performance_sources: false };
  const result = await loadDashboardPerformance(client, caps("booking.read", "finance.read", "customer.read"), everyBranch, period, "Asia/Jakarta", hidden);
  assert.deepEqual(calls, []);
  assert.deepEqual([result.operations.status, result.finance.status, result.sources.status], ["hidden", "hidden", "hidden"]);
});

test("database refusals and failures degrade one card at a time and are never shown as zero", async () => {
  const { client } = rpcClient({
    dashboard_operations_performance: { data: null, error: { code: "42501", message: "not_authorized" } },
    dashboard_finance_performance: { data: null, error: { code: "PGRST202", message: "function not found" } },
    dashboard_source_performance: { data: null, error: { code: "XX000", message: "boom" } },
  });
  const original = console.error;
  console.error = () => undefined;
  try {
    const result = await loadDashboardPerformance(client, caps("booking.read", "finance.read", "customer.read"), everyBranch, period, "Asia/Jakarta");
    assert.equal(result.operations.status, "restricted");
    assert.equal(result.finance.status, "unavailable");
    assert.match(result.finance.status === "unavailable" ? result.finance.reason : "", /20261030100000/);
    assert.equal(result.sources.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /"data"/);
  } finally {
    console.error = original;
  }
});

test("a forged organization cannot be injected: the loader exposes no organization parameter", () => {
  const source = fs.readFileSync(path.join(root, "apps/web/src/lib/dashboard-performance.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /organization_?id|p_org\b|\.from\(/i);
  assert.equal(loadDashboardPerformance.length >= 5, true);
});

test("operations rows are shaped per period and default to zero only for a returned period", () => {
  const data = parseOperationsRows([
    { period: "previous", completed: 2, open_count: 1, canceled: 0, no_show: 0 },
    { period: "current", completed: "3", open_count: 1, canceled: 1, no_show: 1 },
    { period: "weird", completed: 99 },
  ]);
  assert.deepEqual(data.current, { completed: 3, open: 1, canceled: 1, noShow: 1 });
  assert.deepEqual(data.previous, { completed: 2, open: 1, canceled: 0, noShow: 0 });
});

test("finance rows keep currencies separate and never sum across them", () => {
  const row = (period: string, currency: string, extra: Record<string, unknown>) => ({
    period, currency, issued_total: 0, issued_count: 0, collected_total: 0, collected_count: 0, collected_on_void_count: 0,
    refunded_total: 0, refunded_count: 0, outstanding_total: 0, outstanding_count: 0, overdue_count: 0, ...extra,
  });
  const data = parseFinanceRows([
    row("current", "USD", { collected_total: "40", collected_count: 1 }),
    row("current", "IDR", { collected_total: 1115000, collected_count: 5, collected_on_void_count: 1, issued_total: 1650000, issued_count: 5 }),
    row("previous", "IDR", { collected_total: 110000 }),
    row("snapshot", "IDR", { outstanding_total: 550000, outstanding_count: 2, overdue_count: 1 }),
    row("snapshot", "SGD", { outstanding_total: 5, outstanding_count: 1 }),
  ]);
  assert.deepEqual(data.currencies.map((entry) => entry.currency), ["IDR", "SGD", "USD"]);
  const idr = data.currencies[0];
  assert.deepEqual([idr.current.collectedTotal, idr.previous.collectedTotal, idr.outstanding.total, idr.outstanding.overdue, idr.current.collectedOnVoid], [1115000, 110000, 550000, 1, 1]);
  assert.equal(data.currencies[2].current.collectedTotal, 40);
  assert.equal(data.currencies[2].previous.collectedTotal, 0);
  assert.deepEqual(parseFinanceRows([]), { currencies: [] });
  assert.deepEqual(parseFinanceRows([{ period: "current", currency: "" }, { period: "current" }]), { currencies: [] });
});

test("source rows merge both periods, fold into other/missing, and carry no customer data", () => {
  const rows = [
    { period: "current", source_label: "Instagram", is_missing: false, is_other: false, source_count: 1, new_customers: 2, first_completed: 1, first_paid: 2, customer_id: "x", phone: "0812", display_name: "Budi" },
    { period: "previous", source_label: "INSTAGRAM", is_missing: false, is_other: false, source_count: 1, new_customers: 1, first_completed: 1, first_paid: 1, email: "a@b.c" },
    { period: "current", source_label: null, is_missing: true, is_other: false, source_count: 1, new_customers: 2, first_completed: 0, first_paid: 0 },
    { period: "current", source_label: null, is_missing: false, is_other: true, source_count: 5, new_customers: 5, first_completed: 0, first_paid: 0 },
    { period: "current", source_label: "Teman", is_missing: false, is_other: false, source_count: 1, new_customers: 1, first_completed: 0, first_paid: 0 },
  ];
  const data = parseSourceRows(rows, true, true);
  assert.deepEqual(data.rows.map((row) => row.kind), ["named", "named", "other", "missing"]);
  const instagram = data.rows[0];
  assert.equal(instagram.label, "Instagram");
  assert.deepEqual([instagram.current.newCustomers, instagram.previous.newCustomers, instagram.previous.firstPaid], [2, 1, 1]);
  assert.equal(data.rows[2].sourceCount, 5);
  assert.doesNotMatch(JSON.stringify(data), /0812|Budi|a@b\.c|customer_id|phone|email|display_name/);
});

test("columns the caller may not read are null (unavailable), never zero", () => {
  const data = parseSourceRows([{ period: "current", source_label: "Teman", is_missing: false, is_other: false, source_count: 1, new_customers: 3, first_completed: null, first_paid: null }], false, false);
  assert.equal(data.rows[0].current.firstCompleted, null);
  assert.equal(data.rows[0].current.firstPaid, null);
  assert.equal(data.rows[0].previous.firstPaid, null, "an absent previous row is zero customers, but a denied column is still null");
  const html = renderToStaticMarkup(<PerformanceDashboard period={period} periodError={null} timeZone="Asia/Jakarta" performance={ready({ sources: { status: "ready", data } })} />);
  assert.match(html, /—/);
  assert.match(html, /membutuhkan booking\.read/);
  assert.match(html, /membutuhkan finance\.read/);
});

test("change text is neutral and handles a zero baseline", () => {
  assert.deepEqual(describeChange(5, 5).direction, "same");
  assert.equal(describeChange(8, 6).text, "+2 (+33%) dibanding periode sebelumnya (6).");
  assert.equal(describeChange(3, 6).text, "−3 (−50%) dibanding periode sebelumnya (6).");
  assert.equal(describeChange(4, 0).text, "+4 dibanding periode sebelumnya (0).");
  assert.match(formatMoney(1500, "IDR"), /1\.500/);
  assert.equal(formatMoney(5, "not-a-currency"), "not-a-currency 5");
});

function ready(overrides: Partial<DashboardPerformance> = {}): DashboardPerformance {
  return {
    operations: { status: "ready", data: parseOperationsRows([{ period: "current", completed: 3, open_count: 1, canceled: 1, no_show: 1 }, { period: "previous", completed: 2, open_count: 0, canceled: 0, no_show: 0 }]) },
    finance: { status: "ready", data: parseFinanceRows([
      { period: "current", currency: "IDR", issued_total: 1650000, issued_count: 5, collected_total: 1115000, collected_count: 5, collected_on_void_count: 1, refunded_total: 130000, refunded_count: 2, outstanding_total: 0, outstanding_count: 0, overdue_count: 0 },
      { period: "snapshot", currency: "IDR", issued_total: 0, issued_count: 0, collected_total: 0, collected_count: 0, collected_on_void_count: 0, refunded_total: 0, refunded_count: 0, outstanding_total: 550000, outstanding_count: 2, overdue_count: 1 },
      { period: "current", currency: "USD", issued_total: 50, issued_count: 1, collected_total: 40, collected_count: 1, collected_on_void_count: 0, refunded_total: 5, refunded_count: 1, outstanding_total: 0, outstanding_count: 0, overdue_count: 0 },
    ]) },
    sources: { status: "ready", data: parseSourceRows([{ period: "current", source_label: "Instagram", is_missing: false, is_other: false, source_count: 1, new_customers: 2, first_completed: 1, first_paid: 2 }], true, true) },
    ...overrides,
  };
}
const render = (performance: DashboardPerformance, periodError: string | null = null) =>
  renderToStaticMarkup(<PerformanceDashboard period={period} periodError={periodError} timeZone="Asia/Jakarta" performance={performance} />);

test("the full dashboard states its period, comparison, definitions and the missing spend/ROI honestly", () => {
  const html = render(ready());
  assert.match(html, /Bulan ini · 1–10 Okt 2026/);
  assert.match(html, /Dibanding 10 hari sebelumnya · 21–30 Sep 2026/);
  assert.match(html, /Definisi angka/);
  assert.match(html, /ROI per sumber tidak tersedia/);
  assert.equal((html.match(/ROI/g) ?? []).length, 1, "ROI may only appear in the sentence that says it is unavailable");
  assert.match(html, /Terdapat lebih dari satu mata uang/);
  assert.match(html, /Mata uang IDR/);
  assert.match(html, /Mata uang USD/);
  assert.match(html, /tidak dijumlahkan/);
  assert.match(html, /1 pembayaran pada periode ini tercatat pada invoice yang sudah dibatalkan/);
  assert.match(html, /Bukan laba|bukan laba/);
  assert.match(html, /href="\/finance"/);
  assert.match(html, /href="\/schedule"/);
  assert.match(html, /href="\/customers"/);
  assert.doesNotMatch(html, /organization|org_id|tenant/i);
});

test("restricted and unavailable cards render a clear state and no figures", () => {
  const html = render({
    operations: { status: "restricted", reason: "Peran ini tidak memiliki booking.read; angka tidak dimuat." },
    finance: { status: "restricted", reason: "Peran ini tidak memiliki finance.read; angka tidak dimuat." },
    sources: { status: "unavailable", reason: "Data tidak dapat dimuat saat ini. Coba muat ulang halaman." },
  });
  assert.equal((html.match(/Tidak tersedia untuk peran ini/g) ?? []).length, 2);
  assert.match(html, /Data belum dapat dimuat/);
  assert.doesNotMatch(html, /Rp|IDR|Selesai|Pembayaran diterima/);
  assert.doesNotMatch(html, /href="\/finance"/);
});

test("hidden cards are absent; all hidden says so; empty data uses empty states, not zeros", () => {
  const hidden = render({ operations: { status: "hidden" }, finance: { status: "hidden" }, sources: { status: "hidden" } });
  assert.match(hidden, /Kartu performa disembunyikan/);
  assert.doesNotMatch(hidden, /Operasional|Keuangan|sumber pelanggan<\/h3>/);
  const empty = render({
    operations: { status: "ready", data: parseOperationsRows([]) },
    finance: { status: "ready", data: parseFinanceRows([]) },
    sources: { status: "ready", data: parseSourceRows([], true, true) },
  });
  assert.match(empty, /Belum ada booking pada periode ini/);
  assert.match(empty, /Belum ada data keuangan pada periode ini/);
  assert.match(empty, /Belum ada aktivitas sumber pada periode ini/);
});

test("the selector offers presets plus a bounded custom range, and surfaces a refused input", () => {
  const html = render(ready(), "Rentang maksimal 366 hari. Menampilkan hari ini.");
  for (const label of ["Hari ini", "7 hari terakhir", "30 hari terakhir", "Bulan ini", "Bulan lalu"]) assert.match(html, new RegExp(label));
  assert.match(html, /href="\/dashboard\?period=30d"/);
  assert.match(html, /name="period" value="custom"/);
  assert.match(html, /<input type="date"[^>]*max="2026-10-10"[^>]*name="from"/);
  assert.match(html, /role="alert"[^>]*>Rentang maksimal 366 hari/);
  assert.match(html, /aria-current="page"[^>]*>Bulan ini/);
});

test("static contract: the migration's definer aggregates, grants and capability checks", () => {
  // A source assertion, NOT an RLS test: the behavioural proof is supabase/tests/20261030100000_test_performance_dashboard.sql.
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261030100000_performance_dashboard.sql"), "utf8");
  for (const fn of ["dashboard_operations_performance", "dashboard_finance_performance", "dashboard_source_performance", "dashboard_check_periods"]) {
    assert.match(sql, new RegExp(`revoke all on function app\\.${fn}\\(date, date, date, date, text\\) from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function app\\.${fn}\\(date, date, date, date, text\\) to authenticated`));
  }
  // Four definers (the card-settings writer and the three aggregates, which resolve branch scope once because the
  // per-row RLS helper is too slow at scale - see the migration header); each pins an empty search_path.
  assert.equal((sql.match(/security definer/g) ?? []).length, 4);
  assert.equal((sql.match(/security definer set search_path = ''/g) ?? []).length, 4);
  assert.equal((sql.match(/security invoker/g) ?? []).length, 1, "only the pure period validator is an invoker");
  // Every aggregate states its tenant and branch filter itself, because a definer bypasses row-level security.
  assert.ok((sql.match(/organization_id = v_org/g) ?? []).length >= 14);
  assert.equal((sql.match(/v_all or \w+\.branch_id = any\(v_branches\)/g) ?? []).length, 5, "operations + issued + collected + refunds + outstanding");
  assert.doesNotMatch(sql, /service_role|create (materialized )?view|pg_cron|create table|insert into|delete from|drop /i);
  assert.match(sql, /app\.has_permission\('finance\.read'\)/);
  assert.match(sql, /app\.has_permission\('branches\.all'\)/);
  assert.match(sql, /app\.fn_active_organization\(\)/);
});
