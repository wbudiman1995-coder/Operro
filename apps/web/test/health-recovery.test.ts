import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DRILL_FRESH_DAYS,
  EXPECTED_SCHEMA_VERSION,
  appVersion,
  deriveReadiness,
  loadHealth,
  loadReconciliationCounts,
  type HealthSummary,
  type ReconciliationCounts,
  type RecoveryStatus,
} from "../src/lib/health";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const NOW = new Date("2026-10-09T00:00:00Z");

const clean: HealthSummary = {
  schema_version: EXPECTED_SCHEMA_VERSION, generated_at: "2026-10-09T00:00:00Z",
  exports: { failed_30d: 0, stale_running: 0, last_completed_at: "2026-10-01T00:00:00Z", last_failure_at: null },
  cleanup: { problem_runs_30d: 0, stale_running: 0, last_apply_status: "completed", last_apply_at: "2026-10-02T00:00:00Z", pending_objects: 0 },
  capacity_requests: { pending: 0, oldest_pending_at: null, stale_pending: 0 },
};
const noDrill: RecoveryStatus = { drills_recorded: 0, last_drill_date: null, last_outcome: null, last_passed_date: null, detail: null };
const zero = { count: 0, capped: false, note: null };
const counts: ReconciliationCounts = { unbilledVisits: zero, invoicePayments: zero, payrollSources: zero };

test("schema version constant tracks the newest migration file and the SQL function (drift fails here)", () => {
  const dir = path.join(root, "supabase/migrations");
  const newest = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().at(-1)!;
  assert.equal(newest.slice(0, 14), EXPECTED_SCHEMA_VERSION, "bump EXPECTED_SCHEMA_VERSION and app.schema_version() in the newest migration");
  const migration = read(`supabase/migrations/${newest}`);
  assert.match(migration, new RegExp(`select '${EXPECTED_SCHEMA_VERSION}'::text`), "the newest migration must (re)define app.schema_version()");
});

test("with no drill on record recovery is explicitly NOT proven, however healthy the signals look", () => {
  const readiness = deriveReadiness(clean, noDrill, counts, NOW);
  assert.equal(readiness.drillState, "never");
  assert.match(readiness.headline, /belum terbukti/);
  assert.deepEqual(readiness.attention, []);
  assert.match(readiness.providerNote, /tidak dibaca oleh aplikasi ini/);
  for (const text of [readiness.headline, readiness.detail]) assert.doesNotMatch(text, /terjamin|aman sepenuhnya|terbukti dapat dipulihkan(?!\.)|sudah dipulihkan/i);
});

test("failed, stale and fresh drills are distinguished and a pass is a dated fact, not a guarantee", () => {
  const failed = deriveReadiness(clean, { ...noDrill, drills_recorded: 1, last_drill_date: "2026-10-01", last_outcome: "failed" }, counts, NOW);
  assert.equal(failed.drillState, "latest_not_passed");
  assert.match(failed.detail, /gagal/);
  const partial = deriveReadiness(clean, { ...noDrill, drills_recorded: 1, last_drill_date: "2026-10-01", last_outcome: "partial" }, counts, NOW);
  assert.match(partial.detail, /sebagian/);
  const old = new Date(NOW.getTime() - (DRILL_FRESH_DAYS + 2) * 86_400_000).toISOString().slice(0, 10);
  const stale = deriveReadiness(clean, { ...noDrill, drills_recorded: 1, last_drill_date: old, last_outcome: "passed", last_passed_date: old }, counts, NOW);
  assert.equal(stale.drillState, "stale");
  assert.match(stale.headline, /kedaluwarsa/);
  const fresh = deriveReadiness(clean, { ...noDrill, drills_recorded: 1, last_drill_date: "2026-10-05", last_outcome: "passed", last_passed_date: "2026-10-05" }, counts, NOW);
  assert.equal(fresh.drillState, "recent_pass");
  assert.match(fresh.headline, /2026-10-05/);
  assert.match(fresh.detail, /bukan jaminan/);
  // a newer failed drill after an older pass still reads as not passed
  const regress = deriveReadiness(clean, { ...noDrill, drills_recorded: 2, last_drill_date: "2026-10-08", last_outcome: "failed", last_passed_date: "2026-09-01" }, counts, NOW);
  assert.equal(regress.drillState, "latest_not_passed");
});

test("failure and stale states each surface as an attention item with counts only", () => {
  const bad: HealthSummary = {
    ...clean, schema_version: "20260101000000",
    exports: { failed_30d: 2, stale_running: 1, last_completed_at: null, last_failure_at: "2026-10-08T00:00:00Z" },
    cleanup: { problem_runs_30d: 1, stale_running: 1, last_apply_status: "partial", last_apply_at: "2026-10-08T00:00:00Z", pending_objects: 3 },
    capacity_requests: { pending: 2, oldest_pending_at: "2026-09-01T00:00:00Z", stale_pending: 1 },
  };
  const readiness = deriveReadiness(bad, noDrill, { unbilledVisits: { count: 100, capped: true, note: null }, invoicePayments: { count: 2, capped: false, note: null }, payrollSources: { count: null, capped: false, note: "Memerlukan izin payroll." } }, NOW);
  const text = readiness.attention.join("\n");
  assert.equal(readiness.schemaMatches, false);
  for (const expected of [/2 export gagal/, /1 export berjalan lebih dari 2 jam/, /1 pembersihan penyimpanan berakhir/, /lease-nya sudah habis/, /3 objek penyimpanan/, /1 permintaan kapasitas menunggu lebih dari 14 hari/, /Versi skema database/, /100\+ kunjungan/, /2 invoice dan pembayaran/]) assert.match(text, expected);
  assert.doesNotMatch(text, /payroll bermasalah/, "an uncountable section is not reported as zero or as a problem");
});

test("reconciliation counts never turn a missing permission or a failure into a reassuring zero", async () => {
  const rpc = (handlers: Record<string, () => unknown>) => ({ schema: () => ({ rpc: async (name: string) => { const data = handlers[name]?.(); if (data instanceof Error) return { data: null, error: { code: "42501", message: data.message } }; return { data, error: null }; } }) });
  const client = rpc({ reconcile_unbilled_visits: () => new Error("denied"), reconcile_invoice_payments: () => [], reconcile_payroll_sources: () => [{ item_id: null, scanned_through: "x", has_more: true }] });
  const result = await loadReconciliationCounts(client as never, { "booking.read": true, "finance.read": true, "payroll.read": true });
  assert.equal(result.unbilledVisits.count, null, "a refused call is 'unavailable', not 0");
  assert.equal(result.invoicePayments.count, 0);
  assert.deepEqual([result.payrollSources.count, result.payrollSources.capped], [0, true], "a partial payroll scan is flagged as partial");
  const restricted = await loadReconciliationCounts(client as never, { "booking.read": false, "finance.read": false, "payroll.read": false });
  assert.deepEqual([restricted.unbilledVisits.count, restricted.invoicePayments.count, restricted.payrollSources.count], [null, null, null]);
});

test("loadHealth fails loudly rather than inventing a healthy default when the database refuses", async () => {
  const client = { schema: () => ({ rpc: async () => ({ data: null, error: { code: "42501", message: "nope" } }) }) };
  await assert.rejects(loadHealth(client as never, {} as never), /health_summary_failed:42501/);
});

test("app version shows only the package version and a 7-hex commit id", () => {
  assert.equal(appVersion({}), "0.1.0");
  assert.equal(appVersion({ VERCEL_GIT_COMMIT_SHA: "abcdef1234567890" }), "0.1.0 (abcdef1)");
  assert.equal(appVersion({ VERCEL_GIT_COMMIT_SHA: "not-a-sha!" }), "0.1.0");
  assert.equal(appVersion({ SUPABASE_SERVICE_ROLE_KEY: "secret" }), "0.1.0");
});

test("page, form and runbook: owner-gated, read-only, no provider calls, a documented manual exercise", () => {
  const page = read("apps/web/src/app/settings/health/page.tsx");
  assert.match(page, /is_business_owner_member/);
  assert.match(page, /Hanya untuk pemilik/);
  const sources = [page, read("apps/web/src/lib/health.ts"), read("apps/web/src/components/health-panel.tsx")].join("\n");
  assert.doesNotMatch(sources, /fetch\(|api\.vercel|management-api|supabase\.com\/dashboard\/api|process\.env\.(?!VERCEL_GIT_COMMIT_SHA)/, "no provider API calls and no env secrets");
  assert.doesNotMatch(read("apps/web/src/components/health-panel.tsx"), /Rp\b|IDR|USD|biaya|harga|tagihan/i, "no provider billing estimates");
  const actions = read("apps/web/src/app/settings/health/actions.ts");
  assert.match(actions, /record_recovery_drill/);
  assert.doesNotMatch(actions, /organization_id|organizationId|p_org/);
  const runbook = read("docs/runbooks/RECOVERY_READINESS.md");
  for (const needle of [/Manual recovery exercise/, /disposable/i, /RPO/, /RTO/, /Storage separately/, /Never put credentials/, /not evidence|is not\s+evidence/i, /supabase\.com\/docs\/guides\/platform\/backups/]) assert.match(runbook, needle);
  const migration = read("supabase/migrations/20261029170000_health_recovery.sql");
  assert.match(migration, /append-only/);
  assert.doesNotMatch(migration, /pg_database_size|http_post|pg_net/);
});
