import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { AUDIT_ENTITY_LABELS, auditEntityLabel, auditWindow, loadAuditPage, parseAuditFilters, summarizeChange } from "../src/lib/audit-viewer";
import { ISSUE_COPY, loadInvoicePaymentIssues, loadUnbilledVisits, scanPayrollSources } from "../src/lib/reconciliation";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const UUID = "00000000-0000-4000-8000-000000000001";

function rpcClient(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return { calls, schema: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: handlers[name]?.(args) ?? [], error: null }; } }) };
}

test("audit filters validate every input and never pass raw text through", () => {
  const ok = parseAuditFilters({ table: "invoices", action: "UPDATE", actor: UUID, from: "2026-10-01", to: "2026-10-31", cursor: `2026-10-05T00:00:00.000Z_${UUID}` });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.filters.cursor, { at: "2026-10-05T00:00:00.000Z", id: UUID });
  for (const bad of [{ table: "Invoices; drop" }, { table: "../x" }, { action: "TRUNCATE" }, { actor: "me" }, { from: "2026-02-30" }, { from: "2026-11-01", to: "2026-10-01" }, { cursor: "garbage" }, { cursor: `nope_${UUID}` }]) {
    assert.equal(parseAuditFilters(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseAuditFilters({}).ok, true);
});

test("audit window uses business-zone day boundaries, inclusive of the end day", () => {
  const window = auditWindow({ from: "2026-10-01", to: "2026-10-31" }, "Asia/Jakarta");
  assert.equal(window.from, "2026-09-30T17:00:00.000Z");
  assert.equal(window.to, "2026-10-31T17:00:00.000Z");
  assert.deepEqual(auditWindow({ from: null, to: null }, "UTC"), { from: null, to: null });
});

test("changed-field summaries come from the reduced diff and use readable labels", () => {
  assert.deepEqual(summarizeChange("UPDATE", { old: { display_name: "A", notes: null }, new: { display_name: "B", notes: "x" } }), [
    { field: "Nama pelanggan", before: "A", after: "B" }, { field: "Catatan internal", before: "—", after: "x" },
  ]);
  assert.deepEqual(summarizeChange("INSERT", { new: { display_name: "A" } }), []);
  assert.equal(summarizeChange("UPDATE", { old: { notes: "n".repeat(200) }, new: { notes: "m" } })[0].before.length, 81);
  assert.equal(auditEntityLabel("invoices"), "Invoice");
  assert.equal(auditEntityLabel("some_new_table"), "some_new_table");
  assert.ok(Object.keys(AUDIT_ENTITY_LABELS).length >= 20);
});

test("audit page: asks for one extra row to detect another page, resolves labels, and exposes a keyset cursor", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`, occurred_at: `2026-10-0${i + 1}T00:00:00Z`, actor_id: i === 0 ? null : UUID, actor_label: i === 0 ? "Sistem" : "Ani", action: "UPDATE",
    entity_table: "customers", entity_id: UUID, diff: { old: { notes: "a" }, new: { notes: "b" } },
  }));
  const client = rpcClient({ search_audit_events: () => rows });
  const page = await loadAuditPage(client as never, { table: "customers", action: null, actor: null, from: null, to: null, cursor: null }, "UTC", 2);
  assert.equal(client.calls[0].args.p_limit, 3);
  assert.deepEqual(client.calls[0].args.p_tables, ["customers"]);
  assert.equal(page.rows.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, `2026-10-02T00:00:00Z_00000000-0000-4000-8000-000000000002`);
  assert.equal(page.rows[0].entityLabel, "Pelanggan");
  assert.deepEqual(page.rows[0].changedFieldLabels, ["Catatan internal"]);
  assert.equal(page.rows[0].actorLabel, "Sistem");
  assert.equal("organization_id" in client.calls[0].args, false, "the organization is never sent");
});

test("reconciliation loaders are read-only RPC reads that send no tenancy and paginate with one extra row", async () => {
  const client = rpcClient({
    reconcile_unbilled_visits: () => [{ id: "a", session_source: "booking", branch_id: "b", customer_id: "c", customer_name: "Ani", visit_at: "2026-10-01T00:00:00Z", description: "Booking selesai" }, { id: "b", session_source: "manual", branch_id: "b", customer_id: "c", customer_name: "Budi", visit_at: "2026-09-01T00:00:00Z", description: "Walk-in" }],
    reconcile_invoice_payments: () => [{ invoice_id: "i1", invoice_number: "INV-1", customer_name: "Ani", branch_id: "b", status: "issued", currency: "USD", total: "100", paid_amount: "100", refunded_amount: "0", net_paid: "100", foreign_currency_payments: 0, issue: "paid_in_full_not_closed", issued_at: "2026-10-01T00:00:00Z" }],
    reconcile_payroll_sources: () => [{ item_id: "p1", run_id: "r", branch_id: null, period_start: "2026-09-26", period_end: "2026-10-26", run_status: "paid", membership_id: "m", staff_name: "Siti", snapshot_basic: 3, live_basic: 1, snapshot_styling: 0, live_styling: 0, snapshot_botak: 0, live_botak: 0, issue: "source_reduced", scanned_through: "p1", has_more: true }],
  });
  const visits = await loadUnbilledVisits(client as never, null, 1);
  assert.equal(client.calls[0].args.p_limit, 2);
  assert.equal(visits.hasMore, true);
  assert.deepEqual(visits.nextCursor, { visitAt: "2026-10-01T00:00:00Z", id: "a" });
  const invoices = await loadInvoicePaymentIssues(client as never, null, 25);
  assert.equal(invoices.rows[0].total, 100);
  assert.equal(invoices.rows[0].currency, "USD", "currency is carried per row, never summed");
  assert.equal(invoices.hasMore, false);
  const payroll = await scanPayrollSources(client as never, null);
  assert.equal(payroll.rows[0].issue, "source_reduced");
  assert.deepEqual([payroll.hasMore, payroll.scannedThrough], [true, "p1"]);
  for (const call of client.calls) assert.doesNotMatch(Object.keys(call.args).join(","), /org|branch/);
  const clean = rpcClient({ reconcile_payroll_sources: () => [{ item_id: null, scanned_through: "z", has_more: false }] });
  assert.deepEqual(await scanPayrollSources(clean as never, null), { rows: [], scannedThrough: "z", hasMore: false });
});

test("every discrepancy kind has plain-language copy and none promises an automatic fix", () => {
  for (const [kind, copy] of Object.entries(ISSUE_COPY)) {
    assert.ok(copy.title.length > 10 && copy.detail.length > 20, kind);
    assert.doesNotMatch(`${copy.title} ${copy.detail}`, /otomatis diperbaiki|perbaiki otomatis|auto-?repair/i, kind);
  }
});

test("pages are capability-gated, read-only, and the migration never writes", () => {
  const audit = read("apps/web/src/app/audit/page.tsx");
  const rec = read("apps/web/src/app/reconciliation/page.tsx");
  assert.match(audit, /capabilities\["reports\.view"\]/);
  assert.match(rec, /Tidak ada yang diperbaiki, dibuat, atau diubah otomatis/);
  assert.doesNotMatch(rec + audit, /<form[^>]*method="post"|action=\{/i, "no mutating form on either page");
  assert.doesNotMatch(read("apps/web/src/lib/reconciliation.ts") + read("apps/web/src/lib/audit-viewer.ts"), /\.(insert|update|delete|upsert)\(/);
  const migration = read("supabase/migrations/20261029150000_audit_reconciliation.sql");
  assert.doesNotMatch(migration, /\b(insert into|update public|delete from)\b/i);
  assert.match(migration, /security invoker/);
  assert.match(migration, /payroll_publications/);
  assert.match(migration, /reports\.view/);
});
