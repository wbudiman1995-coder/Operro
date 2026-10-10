import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { before } from "node:test";

import { groupCashByCurrency, parseCashPeriod } from "../src/lib/cash-position";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;
let finance: typeof import("../src/lib/finance-export");

before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  finance = await import("../src/lib/finance-export");
});

const ORG = "org-A";
const OTHER = "org-B";

/** A small chainable fake that honours eq/in/is/order/range so tenant filters are actually exercised. */
function fakeClient(tables: Tables, rpc: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let rows = [...(tables[table] ?? [])];
    let from_ = 0; let to_ = Number.MAX_SAFE_INTEGER; let cap = Number.MAX_SAFE_INTEGER;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push([column, value]); rows = rows.filter((r) => r[column] === value); return builder; },
      in: (column: string, values: unknown[]) => { filters.push([column, values]); rows = rows.filter((r) => values.includes(r[column])); return builder; },
      is: (column: string, value: unknown) => { rows = rows.filter((r) => (r[column] ?? null) === value); return builder; },
      order: (column: string) => { rows.sort((a, b) => String(a[column]).localeCompare(String(b[column]))); return builder; },
      range: (a: number, b: number) => { from_ = a; to_ = b; return builder; },
      limit: (n: number) => { cap = n; return builder; },
      then: (resolve: (value: unknown) => void) => { calls.push({ table, filters }); resolve({ data: rows.slice(from_, Math.min(to_ + 1, from_ + cap)), error: null }); },
    };
    return builder;
  }
  return {
    calls,
    from,
    rpcCalls,
    schema: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { rpcCalls.push({ name, args }); return { data: rpc[name] ? rpc[name](args) : [], error: null }; } }),
  };
}

function payment(i: number, org = ORG, extra: Row = {}): Row {
  return { id: `p${String(i).padStart(4, "0")}`, invoice_id: `i${i}`, invoice_number: `INV-${i}`, billing_mode: "visit", customer_id: "c", customer_name: `Cust ${i}`, customer_phone: null, method: "cash", amount: 1000 + i, status: "succeeded", payment_stage: "not_applicable", proof_attachment_id: null, screenshot_confirmed_at: null, screenshot_confirmed_by: null, bank_validated_at: null, bank_validated_by: null, paid_at: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) - i * 1000).toISOString(), service_month: "2026-10", organization_id: org, ...extra };
}

/** Keyset pager over a fixed register, honouring the p_page_size sentinel and cursor, like the real RPC. */
function registerRpc(all: Row[]) {
  return {
    search_payment_register: (args: Record<string, unknown>) => {
      const size = Math.min(Number(args.p_page_size), 200);
      const sorted = [...all].sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)) || String(b.id).localeCompare(String(a.id)));
      let start = 0;
      if (args.p_cursor_id) start = sorted.findIndex((r) => r.id === args.p_cursor_id) + 1;
      return sorted.slice(start, start + size);
    },
    payment_register_stage_totals: () => [],
  };
}

function cells(book: import("exceljs").Workbook, name: string): unknown[][] {
  const tab = book.getWorksheet(name);
  assert.ok(tab, `sheet ${name} exists`);
  const out: unknown[][] = [];
  tab.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
  return out;
}

const period = { from: "2026-10-01", to: "2026-10-31" };

test("export includes payments, refunds, expenses and cash sheets; mixed currencies stay on their own rows", async () => {
  const tables: Tables = {
    payments: [
      { id: "p0001", organization_id: ORG, currency: "IDR" }, { id: "p0002", organization_id: ORG, currency: "USD" }, { id: "px", organization_id: OTHER, currency: "EUR" },
    ],
    refunds: [
      { id: "r1", organization_id: ORG, payment_id: "p0001", invoice_id: "i1", amount: "30000", status: "succeeded", reason: "salah", refunded_at: "2026-10-10T03:00:00Z" },
      { id: "r2", organization_id: ORG, payment_id: "p0002", invoice_id: null, amount: "5", status: "succeeded", reason: "=HYPERLINK(\"http://evil\")", refunded_at: "2026-10-11T03:00:00Z" },
      { id: "r3", organization_id: OTHER, payment_id: "px", invoice_id: null, amount: "999", status: "succeeded", reason: "other tenant", refunded_at: "2026-10-12T03:00:00Z" },
    ],
    invoices: [{ id: "i1", organization_id: ORG, invoice_number: "INV-1" }],
    expenses: [
      { id: "e1", organization_id: ORG, description: "=cmd|calc", category: "-sewa", amount: 70000, currency: "IDR", status: "recorded", incurred_at: "2026-10-15", deleted_at: null },
      { id: "e2", organization_id: ORG, description: "deleted", category: null, amount: 1, currency: "IDR", status: "recorded", incurred_at: "2026-10-15", deleted_at: "2026-10-16" },
      { id: "e3", organization_id: OTHER, description: "other tenant", category: null, amount: 1, currency: "IDR", status: "recorded", incurred_at: "2026-10-15", deleted_at: null },
    ],
  };
  const client = fakeClient(tables, {
    ...registerRpc([payment(1, ORG, { customer_name: "@evil", method: "cash" }), payment(2, ORG, { customer_name: "+62 812" })]),
    finance_cash_position: () => [
      { period: "2026-10", currency: "IDR", payments_in: "1260000", payments_count: 4, refunds_out: "130000", refunds_count: 2, expenses_out: "385000", expenses_count: 3, net: "745000", excluded_payments: 2 },
      { period: "2026-10", currency: "USD", payments_in: "40", payments_count: 1, refunds_out: "5", refunds_count: 1, expenses_out: "12", expenses_count: 1, net: "23", excluded_payments: 0 },
    ],
  });
  const book = await finance.buildFinanceExport(client as never, ORG, {}, { period, timeZone: "Asia/Jakarta" });
  assert.deepEqual(book.worksheets.map((s) => s.name), ["Pembayaran", "Pengembalian Dana - Semua", "Pengeluaran - Semua", "Posisi Kas", "Catatan Kas"]);

  const refunds = cells(book, "Pengembalian Dana - Semua");
  assert.equal(refunds.length, 3, "header + the 2 refunds of THIS tenant (the other tenant's refund never appears)");
  assert.deepEqual(refunds[1].slice(0, 4), ["INV-1", 30000, "IDR", "succeeded"]);
  assert.equal(refunds[2][2], "USD", "refund currency comes from its payment, not a default");
  assert.equal(String(refunds[2][4]).startsWith("'="), true, "formula-like refund reason is neutralised");

  const expenses = cells(book, "Pengeluaran - Semua");
  assert.equal(expenses.length, 2, "soft-deleted and other-tenant expenses are excluded");
  assert.equal(String(expenses[1][0]).startsWith("'="), true);
  assert.equal(String(expenses[1][1]).startsWith("'-"), true);

  const payments = cells(book, "Pembayaran");
  assert.equal(payments.length, 3);
  assert.equal(String(payments[1][1]).startsWith("'@"), true);
  assert.equal(String(payments[2][1]).startsWith("'+"), true);
  assert.deepEqual(payments.slice(1).map((r) => r[4]).sort(), ["IDR", "USD"], "payment currency column is looked up per payment");

  const cash = cells(book, "Posisi Kas");
  assert.equal(cash.length, 3);
  assert.deepEqual(cash[1].slice(0, 2), ["2026-10", "IDR"]);
  assert.deepEqual(cash[2].slice(0, 2), ["2026-10", "USD"]);
  const notes = cells(book, "Catatan Kas").map((r) => String(r[1])).join("\n");
  assert.match(notes, /Bukan buku besar akuntansi/);
  assert.match(notes, /tidak pernah dijumlahkan/);
  assert.match(notes, /2026-10-01 s\.d\. 2026-10-31/);

  // Every tenant-owned table read is scoped by organization_id.
  for (const call of client.calls) assert.ok(call.filters.some(([column, value]) => column === "organization_id" && value === ORG), `${call.table} read is organization-scoped`);
});

test("register filters and the cash period reach the database, and the organization is never sent", async () => {
  const client = fakeClient({}, { ...registerRpc([]), finance_cash_position: () => [] });
  await finance.buildFinanceExport(client as never, ORG, { stage: "bank_validated", serviceMonth: "2026-10", search: "ani" }, { period, timeZone: "Asia/Jakarta" });
  const register = client.rpcCalls.filter((call) => call.name === "search_payment_register");
  assert.ok(register.length >= 1);
  assert.deepEqual([register[0].args.p_stage, register[0].args.p_service_month, register[0].args.p_search], ["bank_validated", "2026-10", "ani"]);
  const cash = client.rpcCalls.find((call) => call.name === "finance_cash_position");
  assert.deepEqual(cash?.args, { p_from: "2026-10-01", p_to: "2026-10-31", p_timezone: "Asia/Jakarta" });
  for (const call of client.rpcCalls) assert.doesNotMatch(Object.keys(call.args).join(","), /org/i);
});

test("empty history still produces every sheet with headers only", async () => {
  const client = fakeClient({}, { ...registerRpc([]), finance_cash_position: () => [] });
  const book = await finance.buildFinanceExport(client as never, ORG, {}, { period, timeZone: "UTC" });
  for (const name of ["Pembayaran", "Pengembalian Dana - Semua", "Pengeluaran - Semua", "Posisi Kas"]) assert.equal(cells(book, name).length, 1, name);
});

test("pagination: the payment sheet contains every register row beyond one RPC page", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => payment(i + 1));
  const tables: Tables = { payments: rows.map((r) => ({ id: r.id, organization_id: ORG, currency: "IDR" })) };
  const book = await finance.buildFinanceExport(fakeClient(tables, { ...registerRpc(rows), finance_cash_position: () => [] }) as never, ORG, {});
  assert.equal(cells(book, "Pembayaran").length, 451);
  assert.equal(new Set(cells(book, "Pembayaran").slice(1).map((r) => r[0])).size, 450, "no duplicates across page boundaries");
  assert.equal(book.getWorksheet("Posisi Kas"), undefined, "no cash sheet unless a period is requested");
});

test("refunds spanning more than one 500-row page are all exported", async () => {
  const refunds = Array.from({ length: 1203 }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, organization_id: ORG, payment_id: "p0001", invoice_id: null, amount: "1", status: "succeeded", reason: null, refunded_at: "2026-10-10T00:00:00Z" }));
  const book = await finance.buildFinanceExport(fakeClient({ refunds, payments: [{ id: "p0001", organization_id: ORG, currency: "IDR" }] }, { ...registerRpc([]), finance_cash_position: () => [] }) as never, ORG, {});
  assert.equal(cells(book, "Pengembalian Dana - Semua").length, 1204);
});

test("cash period parsing: default is the business month so far; bad ranges are errors, never guesses", () => {
  const now = new Date("2026-10-31T18:00:00Z"); // 1 Nov 01:00 in Jakarta
  assert.deepEqual(parseCashPeriod(undefined, undefined, now, "Asia/Jakarta"), { ok: true, period: { from: "2026-11-01", to: "2026-11-01" } });
  assert.deepEqual(parseCashPeriod(undefined, undefined, now, "UTC"), { ok: true, period: { from: "2026-10-01", to: "2026-10-31" } });
  assert.equal(parseCashPeriod("2026-10-01", "2026-10-31", now, "UTC").ok, true);
  for (const [from, to] of [["2026-10-31", "2026-10-01"], ["2026-02-30", "2026-03-01"], ["2026-10-01", undefined], ["abc", "2026-10-01"], ["2025-01-01", "2026-10-31"], ["1999-12-01", "2000-01-01"]] as const) {
    assert.equal(parseCashPeriod(from, to, now, "UTC").ok, false, `${from}..${to}`);
  }
});

test("per-currency totals never mix currencies and round to cents", () => {
  const rows = [
    { period: "2026-10", currency: "USD", paymentsIn: 0.1, paymentsCount: 1, refundsOut: 0, refundsCount: 0, expensesOut: 0, expensesCount: 0, net: 0.1, excludedPayments: 0 },
    { period: "2026-11", currency: "USD", paymentsIn: 0.2, paymentsCount: 1, refundsOut: 0, refundsCount: 0, expensesOut: 0, expensesCount: 0, net: 0.2, excludedPayments: 1 },
    { period: "2026-10", currency: "IDR", paymentsIn: 1000, paymentsCount: 1, refundsOut: 100, refundsCount: 1, expensesOut: 50, expensesCount: 1, net: 850, excludedPayments: 0 },
  ];
  const totals = groupCashByCurrency(rows);
  assert.deepEqual(totals.map((t) => t.currency), ["IDR", "USD"]);
  assert.equal(totals[1].paymentsIn, 0.3);
  assert.equal(totals[1].excludedPayments, 1);
  assert.equal(totals[0].net, 850);
});

test("route and page keep the finance.read gate and a read-only SQL function", () => {
  const route = read("apps/web/src/app/finance/export/route.ts");
  assert.match(route, /capabilities\["finance\.read"\]/);
  assert.match(route, /parseCashPeriod/);
  const page = read("apps/web/src/app/finance/page.tsx");
  assert.match(page, /canReadFinance/);
  assert.match(page, /Tidak ada izin melihat posisi kas/);
  const migration = read("supabase/migrations/20261029130000_finance_cash_position.sql");
  assert.match(migration, /security invoker/);
  assert.match(migration, /stable/);
  assert.doesNotMatch(migration, /\b(insert|update|delete)\b\s+(into|from)?\s*public\./i);
  assert.doesNotMatch(migration, /create table/i, "no accounting ledger table");
});
