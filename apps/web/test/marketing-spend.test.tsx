import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { MarketingSpendPanel } from "../src/components/marketing-spend-panel";
import { PerformanceDashboard } from "../src/components/performance-dashboard";
import { CAPABILITY_KEYS, type BranchAccess, type CapabilityMap } from "../src/lib/authorization";
import { loadDashboardPerformance, type DashboardPerformance } from "../src/lib/dashboard-performance";
import { resolveDashboardPeriod } from "../src/lib/dashboard-period";
import {
  describeSpendError, formatRatio, groupSpendByCurrency, loadMarketingSpend, parseSourceReturnRows, parseSpendRows, RETURN_DEFINITION, RETURN_ROW_LIMIT, validateSpendForm,
  type MarketingSpend,
} from "../src/lib/marketing-spend";

const root = path.resolve(import.meta.dirname, "../../..");
const caps = (...granted: (keyof CapabilityMap)[]): CapabilityMap => {
  const map = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as CapabilityMap;
  for (const key of granted) map[key] = true;
  return map;
};
const everyBranch: BranchAccess = { all: true, ids: new Set() };
const period = (() => { const r = resolveDashboardPeriod({ period: "month" }, new Date("2026-10-10T05:00:00Z"), "Asia/Jakarta"); assert.ok(r.ok); return r.period; })();

const roiRow = (over: Record<string, unknown> = {}) => ({
  source_key: "instagram", source_label: "Instagram", currency: "IDR", spend: 250000, spend_entries: 2, cohort_customers: 3, paying_customers: 3,
  collected: 540000, refunded: 50000, net_revenue: 490000, net_result: 240000, ratio: 1.96, has_spend: true, ...over,
});

test("source return rows keep their own currency and never invent a ratio without spend", () => {
  const parsed = parseSourceReturnRows([
    roiRow(),
    roiRow({ source_key: "teman", source_label: "Teman", spend: 0, spend_entries: 0, has_spend: false, ratio: null, net_revenue: 50000, collected: 50000, refunded: 0, net_result: 50000 }),
    roiRow({ source_key: "google", source_label: "Google", currency: "USD", spend: 0, has_spend: false, ratio: 7, net_revenue: 20, collected: 20, refunded: 0 }),
    { source_label: "no key" },
  ]);
  assert.equal(parsed.rows.length, 3, "a row without a source key is dropped");
  assert.equal(parsed.rows[0].ratio, 1.96);
  assert.equal(parsed.rows[1].ratio, null);
  assert.equal(parsed.rows[2].ratio, null, "even if the database sent a ratio, no spend means no ratio");
  assert.deepEqual(parsed.rows.map((row) => row.currency), ["IDR", "IDR", "USD"]);
});

test("an over-long result is cut at the row limit and says so", () => {
  const many = Array.from({ length: RETURN_ROW_LIMIT + 1 }, (_, index) => roiRow({ source_key: `s${index}`, source_label: `S${index}` }));
  const parsed = parseSourceReturnRows(many);
  assert.equal(parsed.rows.length, RETURN_ROW_LIMIT);
  assert.equal(parsed.truncated, true);
  assert.equal(parseSourceReturnRows(many.slice(0, 3)).truncated, false);
  assert.deepEqual(parseSourceReturnRows(null), { rows: [], truncated: false });
});

test("ratio text never shows zero or infinity for a missing denominator", () => {
  assert.equal(formatRatio(null), "—");
  assert.equal(formatRatio(Number.POSITIVE_INFINITY), "—");
  assert.match(formatRatio(1.96), /^1,96×$/);
});

test("net spend is grouped per currency and reversals subtract", () => {
  const entries = parseSpendRows([
    { id: "a", kind: "spend", source_label: "Instagram", source_key: "instagram", spent_on: "2026-10-03", amount: "100000.00", currency: "IDR", created_at: "x" },
    { id: "b", kind: "reversal", source_label: "Instagram", source_key: "instagram", spent_on: "2026-10-03", amount: "100000.00", currency: "IDR", reversal_of: "a", note: "Duplikat", created_at: "x" },
    { id: "c", kind: "spend", source_label: "Instagram", source_key: "instagram", spent_on: "2026-10-04", amount: 5, currency: "USD", created_at: "x" },
    { kind: "spend" },
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(groupSpendByCurrency(entries), [{ currency: "IDR", net: 0, entries: 1 }, { currency: "USD", net: 5, entries: 1 }]);
});

test("the spend form is checked in the browser the way the database will check it", () => {
  const ok = { source: "  Instagram   ads ", amount: "250000", currency: "idr", spentOn: "2026-10-03", note: "" };
  assert.deepEqual(validateSpendForm(ok, "2026-10-13"), { ok: true, amount: 250000, source: "Instagram ads", currency: "IDR" });
  for (const bad of [
    { ...ok, source: "   " }, { ...ok, source: "x".repeat(81) }, { ...ok, source: "bad\u0001" }, { ...ok, amount: "0" }, { ...ok, amount: "-5" }, { ...ok, amount: "10.005" },
    { ...ok, amount: "1000000000000" }, { ...ok, amount: "abc" }, { ...ok, currency: "RP" }, { ...ok, spentOn: "2026-10-14" }, { ...ok, spentOn: "1999-12-31" }, { ...ok, spentOn: "2026-1-1" },
    { ...ok, note: "n".repeat(201) },
  ]) assert.equal(validateSpendForm(bad, "2026-10-13").ok, false, JSON.stringify(bad));
});

test("database errors become plain language and never leak raw text", () => {
  assert.match(describeSpendError({ code: "42501", message: "not_authorized" }), /finance\.manage/);
  assert.match(describeSpendError({ message: "already_reversed" }), /sudah dibalik/);
  assert.match(describeSpendError({ code: "22023", message: "invalid_spend" }), /Input tidak valid/);
  const unknown = describeSpendError({ code: "XX000", message: "relation \"secret_table\" does not exist" });
  assert.doesNotMatch(unknown, /secret_table|relation/);
});

const render = (performance: DashboardPerformance) =>
  renderToStaticMarkup(<PerformanceDashboard period={period} periodError={null} timeZone="Asia/Jakarta" performance={performance} canManageSpend />);
const baseCards: DashboardPerformance = {
  operations: { status: "hidden" }, finance: { status: "hidden" },
  sources: { status: "ready", data: { rows: [], bookingColumnAvailable: true, financeColumnAvailable: true } },
  sourceReturn: { status: "hidden" },
};

test("with no recorded spend the dashboard says ROI is unavailable and offers the spend page", () => {
  const html = render({ ...baseCards, sourceReturn: { status: "ready", data: { rows: [], truncated: false } } });
  assert.match(html, /ROI per sumber tidak tersedia/);
  assert.match(html, /href="\/finance\/marketing"/);
  assert.equal((html.match(/ROI/g) ?? []).length, 1);
  // Revenue without any spend is not a return either.
  const revenueOnly = render({ ...baseCards, sourceReturn: { status: "ready", data: parseSourceReturnRows([roiRow({ spend: 0, has_spend: false, ratio: null, spend_entries: 0 })]) } });
  assert.match(revenueOnly, /ROI per sumber tidak tersedia/);
  assert.doesNotMatch(revenueOnly, /1,96/);
});

test("with spend the return is shown per currency with its definition and no profit claim", () => {
  const data = parseSourceReturnRows([
    roiRow(),
    roiRow({ source_key: "teman", source_label: "Teman", spend: 0, spend_entries: 0, has_spend: false, ratio: null, collected: 50000, refunded: 0, net_revenue: 50000, net_result: 50000 }),
    roiRow({ source_key: "instagram", currency: "USD", spend: 5, collected: 20, refunded: 0, net_revenue: 20, net_result: 15, ratio: 4 }),
  ]);
  const html = render({ ...baseCards, sourceReturn: { status: "ready", data } });
  assert.match(html, /ROI sederhana per sumber/);
  assert.match(html, /1,96×/);
  assert.match(html, /4,00×/);
  assert.match(html, /Tidak dicatat/, "a source without spend is labelled, not given a ratio");
  assert.match(html, /Terdapat lebih dari satu mata uang/);
  assert.equal((html.match(/<caption/g) ?? []).length, 2, "one table per currency");
  for (const line of RETURN_DEFINITION) assert.ok(html.includes(line.replace(/&/g, "&amp;")), `definition shown: ${line.slice(0, 40)}`);
  assert.doesNotMatch(html, /laba bersih|keuntungan|profit(?! )/i);
});

test("a restricted or failed return is a note, never a table or a zero", () => {
  const restricted = render({ ...baseCards, sourceReturn: { status: "restricted", reason: "ROI per sumber memerlukan finance.read; angka tidak dimuat." } });
  assert.match(restricted, /memerlukan finance\.read/);
  assert.doesNotMatch(restricted, /<caption|×/);
  const failed = render({ ...baseCards, sourceReturn: { status: "unavailable", reason: "ROI per sumber tidak dapat dimuat saat ini." } });
  assert.match(failed, /tidak dapat dimuat/);
  assert.doesNotMatch(failed, /<caption|×/);
});

test("the dashboard loader makes no return query unless every capability is held", async () => {
  const calls: string[] = [];
  const client = { schema: () => ({ rpc: async (name: string) => { calls.push(name); return { data: [], error: null }; } }), from: () => { throw new Error("no direct reads"); } } as never;
  const noFinance = await loadDashboardPerformance(client, caps("booking.read", "customer.read"), everyBranch, period, "Asia/Jakarta");
  assert.equal(noFinance.sourceReturn.status, "restricted");
  const noCustomers = await loadDashboardPerformance(client, caps("booking.read", "finance.read"), everyBranch, period, "Asia/Jakarta");
  assert.equal(noCustomers.sourceReturn.status, "restricted");
  const narrow = await loadDashboardPerformance(client, caps("finance.read", "customer.read"), { all: false, ids: new Set(["b"]) }, period, "Asia/Jakarta");
  assert.equal(narrow.sourceReturn.status, "restricted");
  const hiddenCard = await loadDashboardPerformance(client, caps("finance.read", "customer.read"), everyBranch, period, "Asia/Jakarta", { booking_today: true, revenue_today: true, active_customers: true, open_tasks: true, performance_operations: true, performance_finance: true, performance_sources: false, operational_alerts: true });
  assert.equal(hiddenCard.sourceReturn.status, "hidden");
  assert.equal(calls.includes("dashboard_source_roi"), false, "no denied caller reached the database");
});

test("the spend page: empty, failed and read-only states are honest", () => {
  const empty: MarketingSpend = { entries: [], hasMore: false, nextCursor: null, reversed: new Set() };
  const keys = { entry: "00000000-0000-4000-8000-000000000001", reversals: {} };
  const readOnly = renderToStaticMarkup(<MarketingSpendPanel spend={empty} canManage={false} today="2026-10-13" requestKeys={keys} error={null} nextHref={null} />);
  assert.match(readOnly, /Belum ada biaya pemasaran tercatat/);
  assert.match(readOnly, /tidak memiliki finance\.manage/);
  assert.doesNotMatch(readOnly, /Catat biaya pemasaran<\/h2>/);
  const failed = renderToStaticMarkup(<MarketingSpendPanel spend={null} canManage={true} today="2026-10-13" requestKeys={keys} error="Biaya pemasaran belum dapat dimuat." nextHref={null} />);
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /Belum ada biaya pemasaran tercatat/, "a failed load is not shown as an empty ledger");
  const entries = parseSpendRows([
    { id: "a", kind: "spend", source_label: "Instagram", source_key: "instagram", spent_on: "2026-10-03", amount: 100000, currency: "IDR", created_at: "x" },
    { id: "b", kind: "reversal", source_label: "Instagram", source_key: "instagram", spent_on: "2026-10-03", amount: 100000, currency: "IDR", reversal_of: "a", note: "Duplikat", created_at: "x" },
  ]);
  const full = renderToStaticMarkup(<MarketingSpendPanel spend={{ entries, hasMore: true, nextCursor: { spentOn: "2026-10-03", id: "b" }, reversed: new Set(["a"]) }} canManage={true} today="2026-10-13" requestKeys={{ entry: keys.entry, reversals: { a: keys.entry } }} error={null} nextHref="/finance/marketing?cursor=2026-10-03_b" />);
  assert.match(full, /dibalik/);
  assert.match(full, /pembalikan/);
  assert.match(full, /Muat lebih banyak/);
  assert.equal((full.match(/aria-label="Balik biaya pemasaran"/g) ?? []).length, 0, "a reversed entry and a reversal row offer no reversal form");
});

test("loadMarketingSpend reads through row-level security only and sends no organization id", async () => {
  const seen: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "order", "limit", "or", "in"]) builder[method] = (...args: unknown[]) => { seen.push(`${method}:${args.map(String).join(",")}`); return builder; };
  builder.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
  const client = { from: (table: string) => { seen.push(`from:${table}`); return builder; } } as never;
  const result = await loadMarketingSpend(client, { spentOn: "2026-10-03", id: "00000000-0000-4000-8000-000000000001" });
  assert.deepEqual(result.entries, []);
  assert.ok(seen.includes("from:marketing_spend_entries"));
  assert.equal(seen.some((entry) => /organization/i.test(entry.replace(/select:.*/, ""))), false);
});

test("the library and actions never take an organization from the browser and the page is gated", () => {
  const lib = fs.readFileSync(path.join(root, "apps/web/src/lib/marketing-spend.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(lib, /p_org|organization_id|organizationId/);
  const actions = fs.readFileSync(path.join(root, "apps/web/src/app/finance/marketing/actions.ts"), "utf8");
  assert.doesNotMatch(actions, /p_org|p_organization|organization_id:/);
  assert.match(actions, /finance\.manage/);
  const page = fs.readFileSync(path.join(root, "apps/web/src/app/finance/marketing/page.tsx"), "utf8");
  assert.match(page, /finance\.read/);
  assert.match(page, /branchAccess\.all/);
});
