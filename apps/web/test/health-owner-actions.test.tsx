import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { HealthPanel } from "../src/components/health-panel";
import { deriveOwnerActions, deriveReadiness, EXPECTED_SCHEMA_VERSION, type HealthSummary, type ReconciliationCounts, type RecoveryStatus } from "../src/lib/health";
import { parseExportScope } from "../src/lib/org-export-scope";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const NOW = new Date("2026-10-12T00:00:00Z");

const base: HealthSummary = {
  schema_version: EXPECTED_SCHEMA_VERSION, generated_at: "2026-10-12T00:00:00Z",
  exports: { failed_30d: 0, stale_running: 0, last_completed_at: "2026-10-10T00:00:00Z", last_failure_at: null, completed_archives: 1, newest_completed_at: "2026-10-10T00:00:00Z", unverified_completed: 0, last_verification_ok: true, purge_candidates: 0 },
  cleanup: { problem_runs_30d: 0, stale_running: 0, last_apply_status: "completed", last_apply_at: "2026-10-02T00:00:00Z", pending_objects: 0, schedule_consent: false },
  capacity_requests: { pending: 0, oldest_pending_at: null, stale_pending: 0 },
};
const passedDrill: RecoveryStatus = { drills_recorded: 1, last_drill_date: "2026-10-01", last_outcome: "passed", last_passed_date: "2026-10-01", detail: null };
const noDrill: RecoveryStatus = { drills_recorded: 0, last_drill_date: null, last_outcome: null, last_passed_date: null, detail: null };
const zero = { count: 0, capped: false, note: null };
const clean: ReconciliationCounts = { unbilledVisits: zero, invoicePayments: zero, payrollSources: zero };
const ids = (actions: ReturnType<typeof deriveOwnerActions>) => actions.map((action) => action.id);

test("a healthy, verified, drilled workspace has no pending owner actions", () => {
  assert.deepEqual(deriveOwnerActions(base, passedDrill, clean, null, NOW), []);
});

test("with no drill the first action is always 'recovery not proven', and it points at the runbook, not at a fake button", () => {
  const actions = deriveOwnerActions(base, noDrill, clean, null, NOW);
  assert.deepEqual(ids(actions), ["drill"]);
  assert.equal(actions[0].severity, "attention");
  assert.equal(actions[0].href, null);
  assert.match(actions[0].label, /DISPOSABLE_RESTORE_DRILL/);
  assert.match(deriveOwnerActions(base, { ...passedDrill, last_outcome: "failed" }, clean, null, NOW)[0].text, /tidak lulus/);
  assert.match(deriveOwnerActions(base, { ...passedDrill, last_passed_date: "2026-01-01", last_drill_date: "2026-01-01" }, clean, null, NOW)[0].text, /kedaluwarsa/);
});

test("export findings map to specific, in-app owner actions", () => {
  const failed = deriveOwnerActions({ ...base, exports: { ...base.exports, failed_30d: 2, stale_running: 1 } }, passedDrill, clean, null, NOW);
  assert.deepEqual(ids(failed), ["export_failed", "export_stalled"]);
  assert.ok(failed.every((action) => action.href === "/settings/storage" && action.severity === "attention"));
  assert.deepEqual(ids(deriveOwnerActions({ ...base, exports: { ...base.exports, completed_archives: 0, newest_completed_at: null } }, passedDrill, clean, null, NOW)), ["export_none"]);
  assert.deepEqual(ids(deriveOwnerActions({ ...base, exports: { ...base.exports, unverified_completed: 1, last_verification_ok: null } }, passedDrill, clean, null, NOW)), ["export_unverified"]);
  const bad = deriveOwnerActions({ ...base, exports: { ...base.exports, unverified_completed: 1, last_verification_ok: false } }, passedDrill, clean, null, NOW);
  assert.deepEqual(ids(bad), ["export_verification_failed"], "a failed verification supersedes the 'never verified' nudge");
  assert.match(bad[0].text, /mungkin rusak atau tidak lengkap/);
  assert.deepEqual(ids(deriveOwnerActions({ ...base, exports: { ...base.exports, newest_completed_at: "2026-08-01T00:00:00Z" } }, passedDrill, clean, null, NOW)), ["export_old"]);
  const purge = deriveOwnerActions({ ...base, exports: { ...base.exports, purge_candidates: 3 } }, passedDrill, clean, null, NOW);
  assert.deepEqual(purge.map((action) => [action.id, action.severity]), [["export_purge", "info"]]);
});

test("an older database without the new fields yields no invented export findings", () => {
  const legacy: HealthSummary = { ...base, exports: { failed_30d: 0, stale_running: 0, last_completed_at: null, last_failure_at: null }, cleanup: { problem_runs_30d: 0, stale_running: 0, last_apply_status: null, last_apply_at: null, pending_objects: 0 } };
  assert.deepEqual(deriveOwnerActions(legacy, passedDrill, clean, null, NOW), []);
});

test("the archive scope gap is an attention item only when unreviewed tables actually hold data", () => {
  const withData = parseExportScope({ generated_at: "t", fingerprint: "f".repeat(64), included: [], retention: {}, uncovered: [{ table: "inventory_movements", row_count: 7, capped: false, class: "not_reviewed" }, { table: "grooming_jobs", row_count: 2, capped: false, class: "no_uuid_cursor" }, { table: "roles", row_count: 5, capped: false, class: "access" }] });
  const gap = deriveOwnerActions(base, passedDrill, clean, withData, NOW);
  assert.deepEqual(ids(gap), ["scope_gap"]);
  assert.match(gap[0].text, /2 tabel berisi data tetapi belum masuk arsip/);
  const empty = parseExportScope({ generated_at: "t", fingerprint: "f".repeat(64), included: [], retention: {}, uncovered: [{ table: "inventory_movements", row_count: 0, capped: false, class: "not_reviewed" }, { table: "roles", row_count: 5, capped: false, class: "access" }] });
  assert.deepEqual(deriveOwnerActions(base, passedDrill, clean, empty, NOW), []);
});

test("cleanup, reconciliation, capacity, schema and consent findings each get an action; consent never reads as automation", () => {
  const summary: HealthSummary = {
    ...base, schema_version: "20260101000000",
    cleanup: { ...base.cleanup, problem_runs_30d: 1, stale_running: 1, pending_objects: 4, schedule_consent: true },
    capacity_requests: { pending: 2, oldest_pending_at: "2026-09-01T00:00:00Z", stale_pending: 2 },
  };
  const counts: ReconciliationCounts = { unbilledVisits: { count: 100, capped: true, note: null }, invoicePayments: { count: 3, capped: false, note: null }, payrollSources: { count: null, capped: false, note: "Memerlukan izin payroll." } };
  const actions = deriveOwnerActions(summary, passedDrill, counts, null, NOW);
  assert.deepEqual(ids(actions).sort(), ["capacity_waiting", "cleanup_consent_no_runner", "cleanup_pending", "cleanup_problem", "cleanup_stalled", "reconcile_invoice_payment", "reconcile_unbilled", "schema_mismatch"].sort());
  assert.match(actions.find((action) => action.id === "reconcile_unbilled")!.text, /^100\+ /);
  assert.equal(actions.find((action) => action.id === "reconcile_unbilled")!.href, "/reconciliation");
  assert.ok(!ids(actions).includes("reconcile_payroll_source"), "an unavailable count (null) is never turned into a finding or a zero");
  assert.match(actions.find((action) => action.id === "cleanup_consent_no_runner")!.text, /belum ada penjadwal; tidak ada yang berjalan otomatis/);
  assert.equal(actions.find((action) => action.id === "schema_mismatch")!.href, null);
});

test("panel renders every action with its label, links only to in-app pages, and an empty list is not presented as proof of health", () => {
  const readiness = deriveReadiness(base, noDrill, clean, NOW);
  const actions = deriveOwnerActions({ ...base, exports: { ...base.exports, unverified_completed: 1, last_verification_ok: null } }, noDrill, { ...clean, unbilledVisits: { count: 4, capped: false, note: null } }, null, NOW);
  const html = renderToStaticMarkup(<HealthPanel summary={base} recovery={noDrill} reconciliation={clean} readiness={readiness} version="0.1.0" platform={false} actions={actions} />);
  assert.match(html, /Tindakan untuk pemilik/);
  assert.match(html, /Perlu tindakan/);
  assert.match(html, /href="\/settings\/storage"[^>]*>Jalankan Verifikasi metadata/);
  assert.match(html, /href="\/reconciliation"[^>]*>Tinjau di Rekonsiliasi/);
  assert.match(html, /DISPOSABLE_RESTORE_DRILL/);
  assert.doesNotMatch(html, /href="https?:\/\/(?!supabase\.com|vercel\.com)/);
  const empty = renderToStaticMarkup(<HealthPanel summary={base} recovery={passedDrill} reconciliation={clean} readiness={deriveReadiness(base, passedDrill, clean, NOW)} version="0.1.0" platform={false} actions={[]} />);
  assert.match(empty, /Tidak ada tindakan yang tertunda dari data yang dibaca/);
  assert.match(empty, /bukan jaminan bahwa penyedia sehat/);
  assert.doesNotMatch(empty, /storage_prefix|manifest|token|credential|service_role/i);
});

test("platform data stays platform-only and the page adds no provider call", () => {
  const html = renderToStaticMarkup(<HealthPanel summary={{ ...base, platform: { pending_capacity_requests: 3, oldest_pending_capacity_request_at: null, failed_exports_30d: 9, problem_cleanup_runs_30d: 8 } }} recovery={passedDrill} reconciliation={clean} readiness={deriveReadiness(base, passedDrill, clean, NOW)} version="0.1.0" platform={false} actions={[]} />);
  assert.doesNotMatch(html, /Seluruh platform/, "a business owner never sees platform counts");
  const page = read("apps/web/src/app/settings/health/page.tsx");
  assert.doesNotMatch(page, /fetch\(|api\.vercel|management-api|process\.env/);
  const sql = read("supabase/migrations/20261031160000_health_signals.sql");
  assert.doesNotMatch(sql.replace(/^\s*--.*$/gm, ""), /storage_prefix|failed_reason/, "no path or raw reason is added to the summary");
  assert.match(sql, /schedule_consent/);
});
