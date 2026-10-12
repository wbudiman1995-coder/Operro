import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CashRegisterPanel } from "../src/components/cash-register-panel";
import {
  describeCashError, groupBalancesByCurrency, loadCashRegister, parseMovementRows, parsePositionRows, validateMovementForm,
  type AccountPosition, type CashRegister,
} from "../src/lib/cash-register";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

const account = (extra: Partial<AccountPosition> = {}): AccountPosition => ({
  id: "a1", name: "Kas toko", kind: "cash", currency: "IDR", branchId: null, status: "active", version: 1,
  totalIn: 1750000, totalOut: 380000, balance: 1370000, movementCount: 6, lastMovementOn: "2026-10-05", ...extra,
});
const register = (extra: Partial<CashRegister> = {}): CashRegister => ({
  accounts: [account(), account({ id: "a2", name: "USD box", currency: "USD", balance: 90, totalIn: 100, totalOut: 10 }), account({ id: "a3", name: "Lama", status: "archived", balance: 0, totalIn: 5, totalOut: 5 })],
  movements: [
    { id: "m1", accountId: "a1", kind: "capital_contribution", direction: "in", amount: 500000, currency: "IDR", occurredOn: "2026-10-02", counterparty: "Winston", memo: null, sourceType: null, sourceId: null, reversalOf: null, createdAt: "2026-10-02T00:00:00Z" },
    { id: "m2", accountId: "a1", kind: "cash_out", direction: "out", amount: 150000, currency: "IDR", occurredOn: "2026-10-03", counterparty: null, memo: "Listrik", sourceType: "expense", sourceId: "e1", reversalOf: null, createdAt: "2026-10-03T00:00:00Z" },
    { id: "m3", accountId: "a1", kind: "reversal", direction: "in", amount: 150000, currency: "IDR", occurredOn: "2026-10-04", counterparty: null, memo: "Salah akun", sourceType: "expense", sourceId: "e1", reversalOf: "m2", createdAt: "2026-10-04T00:00:00Z" },
  ],
  hasMore: false, nextCursor: null, reversed: new Set(["m2"]), ...extra,
});
const props = { canManage: true, canCreateOrgWide: true, branches: [{ id: "b1", name: "North" }], today: "2026-10-12", requestKeys: { movement: "11111111-1111-4111-8111-111111111111", reversals: { m1: "22222222-2222-4222-8222-222222222222" } }, error: null, nextHref: null };

test("position and movement rows are parsed defensively; junk rows are dropped", () => {
  const accounts = parsePositionRows([
    { account_id: "a1", account_name: "Kas", kind: "bank", currency: "IDR", branch_id: null, status: "archived", version: "3", total_in: "10.50", total_out: "5", balance: "5.50", movement_count: 2, last_movement_on: "2026-10-01" },
    { account_name: "no id" }, null, { account_id: "a2", currency: 5 },
  ]);
  assert.equal(accounts.length, 1);
  assert.deepEqual([accounts[0].status, accounts[0].version, accounts[0].balance, accounts[0].kind], ["archived", 3, 5.5, "bank"]);
  assert.equal(parsePositionRows(undefined).length, 0);
  const movements = parseMovementRows([{ id: "m", account_id: "a", kind: "cash_in", direction: "out", amount: "2.5", currency: "IDR", occurred_on: "2026-10-01", source_type: "bribe", source_id: "x", created_at: "t" }, { id: 5 }]);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].sourceType, null, "an unknown source type is dropped, never displayed as a link");
  assert.equal(movements[0].direction, "out");
});

test("balances are grouped per currency and never added across currencies", () => {
  const totals = groupBalancesByCurrency(register().accounts);
  assert.deepEqual(totals.map((entry) => [entry.currency, entry.balance, entry.accounts]), [["IDR", 1370000, 2], ["USD", 90, 1]]);
  assert.deepEqual(groupBalancesByCurrency([]), []);
  const cents = groupBalancesByCurrency([account({ balance: 0.1 }), account({ id: "x", balance: 0.2 })]);
  assert.equal(cents[0].balance, 0.3, "floating point noise is rounded to cents");
});

test("movement form pre-checks: amount, date, party, source pairing; the database repeats every rule", () => {
  const ok = { kind: "capital_contribution", amount: "500000", occurredOn: "2026-10-12", counterparty: "Winston", memo: "", sourceType: "", sourceId: "" };
  assert.deepEqual(validateMovementForm(ok, "2026-10-12"), { ok: true, amount: 500000 });
  for (const [patch, reason] of [
    [{ amount: "0" }, "zero"], [{ amount: "-5" }, "negative"], [{ amount: "1.234" }, "three decimals"], [{ amount: "1e6" }, "exponent"], [{ amount: "" }, "empty"],
    [{ amount: "1000000000000" }, "too large"], [{ occurredOn: "2026-10-13" }, "future"], [{ occurredOn: "1999-12-31" }, "too old"], [{ occurredOn: "12/10/2026" }, "bad format"],
    [{ counterparty: "  " }, "capital without a party"], [{ kind: "reversal" }, "reversal is not a plain kind"], [{ kind: "nope" }, "unknown kind"],
    [{ memo: "x".repeat(301) }, "long memo"], [{ sourceType: "expense", sourceId: "" }, "source without id"],
    [{ sourceType: "expense", sourceId: "e1" }, "source on a capital entry"],
  ] as const) {
    assert.equal(validateMovementForm({ ...ok, ...patch }, "2026-10-12").ok, false, reason);
  }
  const link = { ...ok, kind: "cash_out", counterparty: "", sourceType: "expense", sourceId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a" };
  assert.equal(validateMovementForm(link, "2026-10-12").ok, true);
  assert.equal(validateMovementForm({ ...link, sourceType: "payment" }, "2026-10-12").ok, false, "a payment is money in, not out");
  assert.equal(validateMovementForm({ ...link, sourceId: "not-a-uuid" }, "2026-10-12").ok, false);
});

test("error text is plain Indonesian and never leaks raw database messages", () => {
  assert.match(describeCashError({ code: "42501" }), /finance\.manage/);
  assert.match(describeCashError({ code: "22023", message: "opening_balance_exists" }), /saldo awal/i);
  assert.match(describeCashError({ code: "22023", message: "source_already_linked" }), /sudah ditautkan/);
  assert.match(describeCashError({ code: "40001", message: "stale_account" }), /sudah berubah/);
  const unknown = describeCashError({ code: "XX000", message: 'relation "public.cash_movements" does not exist at character 14' });
  assert.doesNotMatch(unknown, /relation|public\.|character/);
});

test("loader: position first, then a keyset page; an extra row means more; reversals are looked up for the shown page", async () => {
  const calls: string[] = [];
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: `m${String(i).padStart(3, "0")}`, account_id: "a1", kind: "cash_in", direction: "in", amount: "1", currency: "IDR", occurred_on: "2026-10-01", created_at: "t" }));
  const builder = (table: string, rowsOut: unknown[]) => {
    const b: Record<string, unknown> = {
      select: (columns: string) => { calls.push(`${table}.select(${columns.slice(0, 20)})`); return b; },
      order: () => b, limit: (n: number) => { calls.push(`limit ${n}`); return b; }, or: (filter: string) => { calls.push(`or ${filter}`); return b; },
      in: (column: string, ids: string[]) => { calls.push(`in ${column} ${ids.length}`); return b; },
      then: (resolve: (value: unknown) => void) => resolve({ data: rowsOut, error: null }),
    };
    return b;
  };
  let fromCalls = 0;
  const client = {
    schema: () => ({ rpc: async (name: string, args: unknown) => { calls.push(`rpc ${name} ${JSON.stringify(args)}`); return { data: [{ account_id: "a1", account_name: "Kas", kind: "cash", currency: "IDR", status: "active", version: 1 }], error: null }; } }),
    from: (table: string) => { fromCalls += 1; return builder(table, fromCalls === 1 ? rows : [{ reversal_of: "m001" }]); },
  };
  const result = await loadCashRegister(client as never, { occurredOn: "2026-10-02", id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a" });
  assert.equal(result.movements.length, 50);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.nextCursor, { occurredOn: "2026-10-01", id: "m049" });
  assert.ok(result.reversed.has("m001"));
  assert.ok(calls.some((call) => call.startsWith("rpc cash_register_position") && call.includes('"p_as_of":null')));
  assert.ok(calls.includes("limit 51"));
  assert.ok(calls.some((call) => call.startsWith("or occurred_on.lt.2026-10-02")));
  assert.ok(!calls.some((call) => /organization/i.test(call)), "no organization identifier is ever sent");
  const failing = { schema: () => ({ rpc: async () => ({ data: null, error: { code: "42501", message: "x" } }) }), from: () => { throw new Error("must not read movements after a denied position"); } };
  await assert.rejects(() => loadCashRegister(failing as never), /cash_register_position_failed:42501/);
  const empty = { schema: () => ({ rpc: async () => ({ data: [], error: null }) }), from: () => { throw new Error("no accounts, no movement read"); } };
  assert.deepEqual((await loadCashRegister(empty as never)).movements, []);
});

test("panel for a manager: per-currency balances, forms, reversal only on live entries, honest copy", () => {
  const html = renderToStaticMarkup(<CashRegisterPanel register={register()} {...props} />);
  assert.match(html, /bukan buku besar akuntansi/);
  assert.match(html, /tidak<\/strong> mengubah saldo ini secara otomatis/);
  assert.match(html, /tidak ada rekonsiliasi dengan rekening bank/);
  assert.match(html, /IDR · 2 akun/);
  assert.match(html, /USD · 1 akun/);
  assert.match(html, /aria-label="Akun kas baru"/);
  assert.match(html, /aria-label="Catat mutasi kas"/);
  assert.match(html, /name="requestKey" value="11111111-1111-4111-8111-111111111111"/);
  assert.equal((html.match(/aria-label="Balik mutasi"/g) ?? []).length, 1, "only the live, non-reversal entry (m1) can be reversed; m2 is reversed and m3 is a reversal");
  assert.match(html, /name="requestKey" value="22222222-2222-4222-8222-222222222222"/);
  assert.match(html, /dibalik/);
  assert.match(html, /arsip/);
  assert.match(html, /Mata uang \(tidak dapat diubah\)/);
  assert.doesNotMatch(html, /name="organization|name="branchId" value|name="currency" value="IDR" type="hidden"/);
});

test("panel for a read-only role shows balances but offers no write control", () => {
  const html = renderToStaticMarkup(<CashRegisterPanel register={register()} {...props} canManage={false} />);
  assert.match(html, /tidak memiliki finance\.manage/);
  assert.doesNotMatch(html, /aria-label="Akun kas baru"|aria-label="Catat mutasi kas"|aria-label="Balik mutasi"|Arsipkan/);
  assert.match(html, /Saldo per akun/);
});

test("panel states: empty register, load failure (never a zero) and paging", () => {
  const empty = renderToStaticMarkup(<CashRegisterPanel register={register({ accounts: [], movements: [] })} {...props} />);
  assert.match(empty, /Belum ada akun kas yang dapat Anda lihat/);
  assert.match(empty, /Belum ada mutasi/);
  const failed = renderToStaticMarkup(<CashRegisterPanel register={null} {...props} error="Register kas belum dapat dimuat. Ini bukan tanda saldo nol: coba muat ulang halaman." />);
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /Belum ada akun kas|Belum ada mutasi|Rp\s?0/);
  const paged = renderToStaticMarkup(<CashRegisterPanel register={register()} {...props} nextHref="/finance/register?cursor=2026-10-01_x" />);
  assert.match(paged, /href="\/finance\/register\?cursor=2026-10-01_x"/);
});

test("branch-limited creator is offered only their branches (no organization-wide option)", () => {
  const html = renderToStaticMarkup(<CashRegisterPanel register={register()} {...props} canCreateOrgWide={false} />);
  assert.doesNotMatch(html, /Semua cabang<\/option>/);
  assert.match(html, /<option value="b1"[^>]*>North<\/option>/);
});

test("actions: finance.manage gate, no tenant/user/currency/direction sent, errors mapped; migration is immutable-by-trigger", () => {
  const actions = read("apps/web/src/app/finance/register/actions.ts");
  assert.ok((actions.match(/finance\.manage/g) ?? []).length >= 4);
  assert.doesNotMatch(actions, /organization_id|organizationId|p_org\b|p_user|p_currency_override|p_direction/);
  assert.match(actions, /rpc\("create_cash_account"/);
  assert.match(actions, /rpc\("record_cash_movement"/);
  assert.match(actions, /rpc\("reverse_cash_movement"/);
  assert.match(actions, /rpc\("set_cash_account_archived"/);
  assert.doesNotMatch(actions, /\.from\("cash_(accounts|movements)"\)\s*\.(insert|update|delete)/);
  const sql = read("supabase/migrations/20261031110000_cash_control_register.sql");
  assert.match(sql, /create trigger trg_cash_movements_immutable before update or delete/);
  assert.match(sql, /grant select on public\.cash_accounts, public\.cash_movements to authenticated/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*cash_(accounts|movements)[^;]*authenticated/i);
  assert.equal((sql.match(/security definer set search_path = ''/g) ?? []).length, 5);
});
