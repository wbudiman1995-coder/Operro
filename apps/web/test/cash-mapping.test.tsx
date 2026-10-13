import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CashMappingList, CashOnHandPanel } from "../src/components/cash-on-hand-panel";
import {
  describeMappingError, loadCashOnHand, ON_HAND_DEFINITION, parseMappingRows, parseOnHandRows, parseUnmappedRows, summarizeOnHand, validateMappingForm,
  type CashOnHand,
} from "../src/lib/cash-mapping";

const root = path.resolve(import.meta.dirname, "../../..");
const row = (over: Record<string, unknown> = {}) => ({
  account_id: "a1", account_name: "Kas toko", kind: "cash", currency: "IDR", branch_id: null, status: "active",
  declared_balance: "1040000.00", payments_in: "100000.00", refunds_out: "20000.00", expenses_out: "180000.00", payroll_out: "407000.00",
  balance: "533000.00", mapped_complete: true, mapped_flows: 7, first_effective: "2026-09-01", ...over,
});

test("a complete account carries every part of its position; an incomplete one carries none of the mapped parts", () => {
  const [complete, partial] = parseOnHandRows([row(), row({ account_id: "a2", account_name: "Pusat", mapped_complete: false, payments_in: "5", balance: "9", mapped_flows: 3 })]);
  assert.equal(complete.balance, 533000);
  assert.equal(complete.mappedFlows, 7);
  assert.equal(partial.complete, false);
  assert.deepEqual([partial.paymentsIn, partial.refundsOut, partial.expensesOut, partial.payrollOut, partial.balance, partial.mappedFlows], [null, null, null, null, null, null], "even if the server sent numbers, an incomplete account never shows them");
  assert.equal(partial.declared, 1040000, "the declared balance stays visible");
  assert.deepEqual(parseOnHandRows(null), []);
  assert.equal(parseOnHandRows([{ account_name: "no id" }]).length, 0);
});

test("totals add complete accounts of one currency only", () => {
  const accounts = parseOnHandRows([
    row(), row({ account_id: "a2", account_name: "BCA", balance: "2150000", mapped_flows: 2 }),
    row({ account_id: "a3", account_name: "USD", currency: "USD", balance: "75" }),
    row({ account_id: "a4", account_name: "Pusat", mapped_complete: false, balance: "999999999" }),
  ]);
  assert.deepEqual(summarizeOnHand(accounts), [{ currency: "IDR", balance: 2683000, accounts: 2 }, { currency: "USD", balance: 75, accounts: 1 }]);
});

test("unmapped flows and mapping history parse with their reasons", () => {
  assert.deepEqual(parseUnmappedRows([{ kind: "payment", currency: "IDR", reason: "not_mapped", flow_count: 2, total_amount: "370000" }, { kind: "x" }]),
    [{ kind: "payment", currency: "IDR", reason: "not_mapped", count: 2, total: 370000 }]);
  const mappings = parseMappingRows([
    { id: "m1", flow: "payment", method: "cash", branch_id: null, account_id: "a1", effective_from: "2026-09-01", created_at: "2026-10-01T00:00:00Z" },
    { id: "m2", flow: "expense", method: null, branch_id: "b1", account_id: null, effective_from: "2026-09-20", created_at: "2026-10-02T00:00:00Z" },
    { id: "m3", flow: "invoice" },
  ]);
  assert.equal(mappings.length, 2);
  assert.equal(mappings[1].accountId, null, "a stop mapping has no account");
});

test("the mapping form is checked the way the database checks it", () => {
  const ok = { flow: "payment", method: "cash", branchId: "", accountId: "00000000-0000-4000-8000-000000000001", effectiveFrom: "2026-09-01" };
  assert.deepEqual(validateMappingForm(ok, "2026-10-13"), { ok: true });
  assert.deepEqual(validateMappingForm({ ...ok, accountId: "" }, "2026-10-13"), { ok: true }, "an empty account is a stop mapping");
  assert.deepEqual(validateMappingForm({ ...ok, flow: "expense", method: "" }, "2026-10-13"), { ok: true });
  for (const bad of [
    { ...ok, flow: "invoice" }, { ...ok, method: "" }, { ...ok, flow: "expense", method: "cash" }, { ...ok, method: "crypto" }, { ...ok, branchId: "north" }, { ...ok, accountId: "kas" },
    { ...ok, effectiveFrom: "2026-10-20" }, { ...ok, effectiveFrom: "1999-01-01" }, { ...ok, effectiveFrom: "2026-9-1" },
  ]) assert.equal(validateMappingForm(bad, "2026-10-13").ok, false, JSON.stringify(bad));
  assert.equal(validateMappingForm({ ...ok, effectiveFrom: "2026-10-14" }, "2026-10-13").ok, true, "tomorrow is allowed (the database allows one day ahead)");
});

test("database errors become plain language and never leak raw text", () => {
  assert.match(describeMappingError({ code: "42501" }), /finance\.manage/);
  assert.match(describeMappingError({ code: "22023", message: "effective_from_not_after_previous" }), /Riwayat tidak dapat ditulis ulang/);
  assert.match(describeMappingError({ code: "22023", message: "account_branch_mismatch" }), /satu cabang/);
  const unknown = describeMappingError({ code: "XX000", message: "relation \"cash_account_mappings\" is broken" });
  assert.doesNotMatch(unknown, /relation|cash_account_mappings/);
});

const accounts = parseOnHandRows([row(), row({ account_id: "a2", account_name: "Pusat", mapped_complete: false })]);
const render = (onHand: CashOnHand | null, error: string | null = null, canManage = true) =>
  renderToStaticMarkup(<CashOnHandPanel onHand={onHand} error={error} canManage={canManage} asOfLabel="Per hari ini (Asia/Jakarta)" />);

test("the panel shows the parts of the position, the unmapped flows and the definition, and claims no bank reconciliation", () => {
  const html = render({ accounts, hasMappings: true, unmapped: [{ kind: "payment", currency: "IDR", reason: "not_mapped", count: 2, total: 370000 }, { kind: "expense", currency: "USD", reason: "currency_mismatch", count: 1, total: 10 }] });
  assert.match(html, /Kas di tangan \(terpetakan\)/);
  assert.match(html, /533\.000/);
  assert.match(html, /Perlu akses semua cabang/, "an incomplete account says why it has no total");
  assert.match(html, /Belum dipetakan ke akun/);
  assert.match(html, /Mata uang berbeda dari akun tujuan/);
  assert.match(html, /tidak digabung antar mata uang/);
  for (const line of ON_HAND_DEFINITION) assert.ok(html.includes(line), `definition shown: ${line.slice(0, 40)}`);
  assert.match(html, /bukan rekonsiliasi bank/);
  assert.doesNotMatch(html, /terekonsiliasi|sudah dicocokkan|cocok dengan bank|laba bersih/i);
  assert.match(html, /href="\/finance\/register\/mapping"/);
  assert.match(html, /Kelola pemetaan/);
  assert.match(render({ accounts, hasMappings: true, unmapped: [] }, null, false), /Lihat pemetaan/);
});

test("without any mapping the panel says the figure is only declared movements", () => {
  const html = render({ accounts: accounts.slice(0, 1), hasMappings: false, unmapped: [] });
  assert.match(html, /Belum ada pemetaan, jadi angka di bawah hanya berisi mutasi yang dicatat di register/);
  assert.doesNotMatch(html, /Semua arus sejak pemetaan pertama/);
});

test("a failed load is an alert, never a zero position; an empty organization has an empty state", () => {
  const failed = render(null, "Kas di tangan belum dapat dimuat. Ini bukan tanda saldo nol: coba muat ulang halaman.");
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /Rp|IDR|Saldo terpetakan/);
  const empty = render({ accounts: [], hasMappings: false, unmapped: [] });
  assert.match(empty, /Belum ada akun kas yang dapat Anda lihat/);
});

test("the mapping history names accounts and branches and marks a stopped mapping", () => {
  const html = renderToStaticMarkup(<CashMappingList
    mappings={parseMappingRows([
      { id: "m1", flow: "payment", method: "bank_transfer", branch_id: "b1", account_id: "a1", effective_from: "2026-09-01", created_at: "2026-10-01T00:00:00Z" },
      { id: "m2", flow: "expense", method: null, branch_id: null, account_id: null, effective_from: "2026-09-20", created_at: "2026-10-02T00:00:00Z" },
    ])}
    accountNames={new Map([["a1", "BCA North"]])} branchNames={new Map([["b1", "North"]])} />);
  assert.match(html, /Transfer bank/);
  assert.match(html, /BCA North/);
  assert.match(html, /Dihentikan/);
  assert.match(html, /Semua cabang/);
  assert.match(renderToStaticMarkup(<CashMappingList mappings={[]} accountNames={new Map()} branchNames={new Map()} />), /Belum ada pemetaan/);
});

test("the loader calls only the two readers and a count, with no organization and a validated zone", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const head = { select: () => Promise.resolve({ count: 3, error: null }) };
  const client = {
    schema: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: [], error: null }; } }),
    from: (table: string) => { assert.equal(table, "cash_account_mappings"); return head; },
  } as never;
  const result = await loadCashOnHand(client, "Asia/Jakarta");
  assert.deepEqual(calls.map((call) => call.name).sort(), ["cash_on_hand", "cash_unmapped_flows"]);
  for (const call of calls) assert.deepEqual(call.args, { p_as_of: null, p_timezone: "Asia/Jakarta" });
  assert.equal(result.hasMappings, true);
  const failing = { schema: () => ({ rpc: async () => ({ data: null, error: { code: "42501", message: "no" } }) }), from: () => head } as never;
  await assert.rejects(() => loadCashOnHand(failing, "Asia/Jakarta"), (error: Error & { code?: string }) => error.code === "42501");
});

test("the library and the action never take an organization from the browser; the page is gated", () => {
  const lib = fs.readFileSync(path.join(root, "apps/web/src/lib/cash-mapping.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(lib, /p_org\b|organization_id|organizationId/);
  const actions = fs.readFileSync(path.join(root, "apps/web/src/app/finance/register/mapping/actions.ts"), "utf8");
  assert.doesNotMatch(actions, /p_org\b|p_organization|organization_id:|p_currency|p_user/);
  assert.match(actions, /finance\.manage/);
  assert.match(fs.readFileSync(path.join(root, "apps/web/src/app/finance/register/mapping/page.tsx"), "utf8"), /finance\.read/);
});
