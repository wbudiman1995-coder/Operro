import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { HealthPanel } from "../src/components/health-panel";
import { RecoveryDrillForm } from "../src/components/recovery-drill-form";
import { deriveOwnerActions, deriveReadiness, EXPECTED_SCHEMA_VERSION, type HealthSummary, type RecoveryStatus, type ReconciliationCounts } from "../src/lib/health";
import { ARCHIVE_KINDS, describeDrillError, describeEvidence, DRILL_KIND_LABELS, DRILL_KINDS, validateDrillForm, type DrillFormInput } from "../src/lib/recovery-evidence";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const H = (n: string) => n.repeat(64);

const base: DrillFormInput = { date: "2026-10-10", outcome: "partial", restoredTo: "disposable_project", kind: "export_archive_dry_run", manifestSha: H("a"), reportSha: "", notes: "", evidenceRef: "", rpo: "", rto: "" };

test("an archive drill can never be recorded as passed, and the evidence fields follow the kind", () => {
  assert.equal(validateDrillForm(base, "2026-10-13").ok, true);
  assert.equal(validateDrillForm({ ...base, kind: "guarded_archive_restore", reportSha: H("b") }, "2026-10-13").ok, true);
  assert.equal(validateDrillForm({ ...base, kind: "provider_backup", outcome: "passed", manifestSha: "", reportSha: "" }, "2026-10-13").ok, true, "only a provider-backup drill may pass");
  for (const kind of ARCHIVE_KINDS) {
    const refused = validateDrillForm({ ...base, kind, outcome: "passed", reportSha: kind === "guarded_archive_restore" ? H("b") : "" }, "2026-10-13");
    assert.ok(!refused.ok && /tidak dapat dicatat sebagai lulus/.test(refused.message), kind);
  }
  const bad: Array<[Partial<DrillFormInput>, RegExp]> = [
    [{ manifestSha: "" }, /memerlukan hash manifes/], [{ manifestSha: H("A") }, /64 karakter hex huruf kecil/], [{ manifestSha: "abc" }, /64 karakter/],
    [{ kind: "guarded_archive_restore", reportSha: "" }, /memerlukan hash laporan/], [{ kind: "export_archive_dry_run", reportSha: H("b") }, /hanya untuk pemulihan arsip terpandu/],
    [{ kind: "provider_backup", manifestSha: H("a") }, /Hash arsip hanya untuk uji arsip/], [{ kind: "tape" }, /Jenis uji tidak valid/], [{ outcome: "great" }, /Hasil tidak valid/],
    [{ restoredTo: "prod" }, /Tujuan pemulihan/], [{ date: "2026-10-14" }, /di masa depan/], [{ date: "13/10/2026" }, /Tanggal uji/],
    [{ rpo: "-1" }, /RPO dan RTO/], [{ rto: "9999999" }, /RPO dan RTO/], [{ rpo: "600000" }, /RPO dan RTO/], [{ notes: "n".repeat(501) }, /Catatan maksimal 500/], [{ evidenceRef: "e".repeat(301) }, /referensi maksimal 300/],
  ];
  for (const [patch, message] of bad) {
    const result = validateDrillForm({ ...base, ...patch }, "2026-10-13");
    assert.ok(!result.ok && message.test(result.message), JSON.stringify(patch).slice(0, 60));
  }
  const ok = validateDrillForm({ ...base, rpo: "30", rto: " 45 ", notes: " catatan ", evidenceRef: " tiket-1 " }, "2026-10-13");
  assert.ok(ok.ok && ok.args.rpo === 30 && ok.args.rto === 45 && ok.args.notes === "catatan" && ok.args.evidenceRef === "tiket-1" && ok.args.manifestSha === H("a") && ok.args.reportSha === null);
});

test("every kind has a label and the labels match the runbook letters", () => {
  assert.equal(DRILL_KINDS.length, 4);
  for (const kind of DRILL_KINDS) assert.ok(DRILL_KIND_LABELS[kind].length > 3);
  assert.match(DRILL_KIND_LABELS.provider_backup, /^A\./);
  assert.match(DRILL_KIND_LABELS.export_archive_dry_run, /^B\./);
  assert.match(DRILL_KIND_LABELS.guarded_archive_restore, /^C\./);
});

test("database errors become plain language and never leak raw text", () => {
  assert.match(describeDrillError({ code: "42501" }), /pemilik platform/);
  assert.match(describeDrillError({ message: "archive_drill_cannot_pass" }), /tidak dapat dicatat sebagai lulus/);
  assert.match(describeDrillError({ message: "invalid_drill_evidence" }), /hash manifes/);
  assert.match(describeDrillError({ message: "credential_like_text" }), /kredensial/);
  assert.match(describeDrillError({ code: "PGRST202" }), /20261101160000 belum diterapkan/);
  assert.doesNotMatch(describeDrillError({ code: "XX000", message: "relation recovery_drills exploded" }), /relation|recovery_drills/);
});

test("evidence wording says what a matching hash proves and what it does not", () => {
  assert.match(describeEvidence("guarded_archive_restore", true), /membuktikan arsipnya ada, bukan bahwa pemulihan terjadi/);
  assert.match(describeEvidence("guarded_archive_restore", false), /TIDAK sama/);
  assert.match(describeEvidence("provider_backup", null), /bukan uji arsip/);
  assert.match(describeEvidence(null, null), /Catatan lama/);
  for (const text of [describeEvidence("export_archive_dry_run", true), describeEvidence("export_archive_dry_run", false)]) assert.doesNotMatch(text, /terbukti dipulihkan|pemulihan berhasil|backup valid/i);
});

test("the drill form offers 'passed' only for a provider-backup drill and no hash field until an archive kind is chosen", () => {
  const html = renderToStaticMarkup(<RecoveryDrillForm />);
  assert.match(html, /<option value="passed"[^>]*>Lulus<\/option>/);
  assert.doesNotMatch(html, /name="manifestSha" required/, "the default (provider backup) has no required hash");
  assert.match(html, /name="manifestSha" value=""/);
  assert.match(html, /tidak dapat dicatat sebagai lulus/);
  assert.match(html, /bukan bahwa pemulihan terjadi/);
  assert.doesNotMatch(html, /type="password"|name="token"|connection string"?\s*\/>/i);
});

const summary = (over: Partial<HealthSummary["cleanup"]> = {}): HealthSummary => ({
  schema_version: EXPECTED_SCHEMA_VERSION, generated_at: "2026-10-13T00:00:00Z",
  exports: { failed_30d: 0, stale_running: 0, last_completed_at: null, last_failure_at: null },
  cleanup: { problem_runs_30d: 0, stale_running: 0, last_apply_status: null, last_apply_at: null, pending_objects: 0, ...over },
  capacity_requests: { pending: 0, oldest_pending_at: null, stale_pending: 0 },
});
const recovery = (detail: RecoveryStatus["detail"] = null): RecoveryStatus => ({ drills_recorded: detail ? 1 : 0, last_drill_date: detail ? "2026-10-12" : null, last_outcome: detail ? "partial" : null, last_passed_date: null, detail });
const quiet: ReconciliationCounts = { unbilledVisits: { count: 0, capped: false, note: null }, invoicePayments: { count: 0, capped: false, note: null }, payrollSources: { count: 0, capped: false, note: null } };
const detail = (over: Record<string, unknown> = {}) => ({ restored_to: "disposable_project", rpo_minutes: null, rto_minutes: null, notes: null, evidence_ref: null, recorded_at: "2026-10-12T00:00:00Z", kind: "guarded_archive_restore", archive_manifest_sha256: H("a"), restore_report_sha256: H("b"), evidence_matches_export: true, ...over });

test("a preview that nobody applied becomes a named owner action, and an unmatched drill hash is an attention item", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const idle = deriveOwnerActions(summary({ unapplied_preview_candidates: 0 }), recovery(), quiet, null, now);
  assert.equal(idle.some((action) => action.id === "cleanup_unapplied_preview"), false);
  const pending = deriveOwnerActions(summary({ unapplied_preview_candidates: 4 }), recovery(), quiet, null, now).find((action) => action.id === "cleanup_unapplied_preview");
  assert.ok(pending);
  assert.equal(pending.severity, "info");
  assert.equal(pending.href, "/settings/storage");
  assert.match(pending.text, /4 berkas/);
  assert.match(pending.text, /Pratinjau saja tidak menghapus apa pun/);
  const older = deriveOwnerActions({ ...summary(), cleanup: { ...summary().cleanup } }, recovery(), quiet, null, now);
  assert.equal(older.some((action) => action.id === "cleanup_unapplied_preview"), false, "an older database without the field derives nothing");
  assert.equal(deriveOwnerActions(summary(), recovery(detail()), quiet, null, now).some((action) => action.id === "drill_evidence_unmatched"), false);
  const unmatched = deriveOwnerActions(summary(), recovery(detail({ evidence_matches_export: false })), quiet, null, now).find((action) => action.id === "drill_evidence_unmatched");
  assert.ok(unmatched && unmatched.severity === "attention");
  assert.equal(deriveOwnerActions(summary(), recovery(null), quiet, null, now).some((action) => action.id === "drill_evidence_unmatched"), false, "a business owner (no detail) never sees it");
});

test("an archive drill never makes recovery look proven", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const readiness = deriveReadiness(summary(), recovery(detail()), quiet, now);
  assert.notEqual(readiness.drillState, "recent_pass");
  const html = renderToStaticMarkup(<HealthPanel summary={summary({ last_dry_run_at: "2026-10-12T00:00:00Z", unapplied_preview_candidates: 4, last_completed_apply_at: null })} recovery={recovery(detail())} reconciliation={quiet} readiness={readiness} version="0.1.0" platform={true} actions={[]} />);
  assert.match(html, /Bukti hash/);
  assert.match(html, /membuktikan arsipnya ada, bukan bahwa pemulihan terjadi/);
  assert.match(html, /Pratinjau pembersihan terakhir/);
  assert.match(html, /4 berkas belum dijalankan/);
  assert.match(html, /Pembersihan selesai terakhir/);
  assert.doesNotMatch(html, /pemulihan terbukti|recovery is proven/i);
  const business = renderToStaticMarkup(<HealthPanel summary={summary()} recovery={recovery(null)} reconciliation={quiet} readiness={readiness} version="0.1.0" platform={false} actions={[]} />);
  assert.doesNotMatch(business, /Bukti hash|Pratinjau pembersihan terakhir/, "no platform detail for a business owner; no cleanup row on an older database");
});

test("the schema version is the newest migration and the action uses the evidence recorder without sending an organization", () => {
  const newest = fs.readdirSync(path.join(root, "supabase/migrations")).filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort().pop()!.slice(0, 14);
  assert.equal(EXPECTED_SCHEMA_VERSION, newest);
  const actions = read("apps/web/src/app/settings/health/actions.ts");
  assert.match(actions, /record_recovery_drill_with_evidence/);
  assert.doesNotMatch(actions, /p_org\b|organization_id|organizationId|\.rpc\("record_recovery_drill"/);
  const page = read("apps/web/src/app/settings/health/page.tsx");
  assert.match(page, /RecoveryDrillForm/);
});
