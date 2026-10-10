/**
 * Function index:
 * - EXPECTED_SCHEMA_VERSION: the newest migration this build was written against (test fails when it drifts).
 * - loadHealth: reads app.health_summary (counts/timestamps only), app.recovery_status and bounded reconciliation counts.
 * - deriveReadiness: pure mapping from those facts to honest, plain-language states and attention items.
 * - appVersion: package version plus the short commit id Vercel injects (never a secret).
 *
 * Read-only. No provider API is called and none is simulated: Supabase and Vercel status, backups and billing are not
 * visible here, and the page says so. "Recovery is proven" is never asserted; at best a drill passed on a given date.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CapabilityMap } from "@/lib/authorization";
import { loadInvoicePaymentIssues, loadUnbilledVisits, scanPayrollSources } from "@/lib/reconciliation";

export const EXPECTED_SCHEMA_VERSION = "20261030100000";
export const DRILL_FRESH_DAYS = 90;
export const RECONCILIATION_COUNT_CAP = 100;

export interface HealthSummary {
  schema_version: string;
  generated_at: string;
  exports: { failed_30d: number; stale_running: number; last_completed_at: string | null; last_failure_at: string | null };
  cleanup: { problem_runs_30d: number; stale_running: number; last_apply_status: string | null; last_apply_at: string | null; pending_objects: number };
  capacity_requests: { pending: number; oldest_pending_at: string | null; stale_pending: number };
  platform?: { pending_capacity_requests: number; oldest_pending_capacity_request_at: string | null; failed_exports_30d: number; problem_cleanup_runs_30d: number };
}
export interface RecoveryStatus {
  drills_recorded: number;
  last_drill_date: string | null;
  last_outcome: "passed" | "failed" | "partial" | null;
  last_passed_date: string | null;
  detail: null | { restored_to: string; rpo_minutes: number | null; rto_minutes: number | null; notes: string | null; evidence_ref: string | null; recorded_at: string };
}
export interface CountResult { count: number | null; capped: boolean; note: string | null }
export interface ReconciliationCounts { unbilledVisits: CountResult; invoicePayments: CountResult; payrollSources: CountResult }

export function appVersion(env: Record<string, string | undefined> = process.env, packageVersion = "0.1.0"): string {
  const commit = env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  return commit && /^[0-9a-f]{7}$/i.test(commit) ? `${packageVersion} (${commit})` : packageVersion;
}

const unavailable = (note: string): CountResult => ({ count: null, capped: false, note });

export async function loadReconciliationCounts(supabase: SupabaseClient, caps: Pick<CapabilityMap, "booking.read" | "finance.read" | "payroll.read">): Promise<ReconciliationCounts> {
  const guarded = async (allowed: boolean, why: string, run: () => Promise<CountResult>): Promise<CountResult> => {
    if (!allowed) return unavailable(why);
    try { return await run(); } catch { return unavailable("Tidak dapat dihitung saat ini (izin atau data)."); }
  };
  const [unbilledVisits, invoicePayments, payrollSources] = await Promise.all([
    guarded(Boolean(caps["booking.read"] && caps["finance.read"]), "Memerlukan izin booking dan keuangan.", async () => {
      const page = await loadUnbilledVisits(supabase, null, RECONCILIATION_COUNT_CAP);
      return { count: page.rows.length, capped: page.hasMore, note: null };
    }),
    guarded(Boolean(caps["finance.read"]), "Memerlukan izin keuangan.", async () => {
      const page = await loadInvoicePaymentIssues(supabase, null, RECONCILIATION_COUNT_CAP);
      return { count: page.rows.length, capped: page.hasMore, note: null };
    }),
    guarded(Boolean(caps["payroll.read"]), "Memerlukan izin payroll.", async () => {
      const scan = await scanPayrollSources(supabase, null, RECONCILIATION_COUNT_CAP);
      return { count: scan.rows.length, capped: scan.hasMore, note: scan.hasMore ? "Hanya sebagian item payroll yang dipindai." : null };
    }),
  ]);
  return { unbilledVisits, invoicePayments, payrollSources };
}

export async function loadHealth(supabase: SupabaseClient, caps: CapabilityMap): Promise<{ summary: HealthSummary; recovery: RecoveryStatus; reconciliation: ReconciliationCounts }> {
  const [summary, recovery] = await Promise.all([
    supabase.schema("app").rpc("health_summary"),
    supabase.schema("app").rpc("recovery_status"),
  ]);
  if (summary.error) throw new Error(`health_summary_failed:${summary.error.code ?? ""}`);
  if (recovery.error) throw new Error(`recovery_status_failed:${recovery.error.code ?? ""}`);
  return { summary: summary.data as HealthSummary, recovery: recovery.data as RecoveryStatus, reconciliation: await loadReconciliationCounts(supabase, caps) };
}

export type DrillState = "never" | "latest_not_passed" | "stale" | "recent_pass";
export interface Readiness {
  drillState: DrillState;
  headline: string;
  detail: string;
  schemaMatches: boolean;
  attention: string[];
  providerNote: string;
}

function daysBetween(fromISO: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

export function deriveReadiness(summary: HealthSummary, recovery: RecoveryStatus, reconciliation: ReconciliationCounts, now = new Date()): Readiness {
  let drillState: DrillState;
  let headline: string;
  let detail: string;
  if (recovery.drills_recorded === 0 || !recovery.last_drill_date) {
    drillState = "never";
    headline = "Pemulihan belum terbukti";
    detail = "Belum ada uji pemulihan (restore drill) yang tercatat. Backup yang ada belum pernah dibuktikan dapat dipulihkan.";
  } else if (recovery.last_outcome !== "passed") {
    drillState = "latest_not_passed";
    headline = "Uji pemulihan terakhir tidak lulus";
    detail = `Uji pada ${recovery.last_drill_date} berstatus ${recovery.last_outcome === "failed" ? "gagal" : "sebagian"}. Pemulihan belum terbukti sampai ada uji yang lulus.`;
  } else if (!recovery.last_passed_date || daysBetween(recovery.last_passed_date, now) > DRILL_FRESH_DAYS) {
    drillState = "stale";
    headline = "Bukti uji pemulihan sudah kedaluwarsa";
    detail = `Uji lulus terakhir ${recovery.last_passed_date ?? "tidak diketahui"} sudah lebih dari ${DRILL_FRESH_DAYS} hari. Ulangi uji sebelum mengandalkannya.`;
  } else {
    drillState = "recent_pass";
    headline = `Uji pemulihan lulus pada ${recovery.last_passed_date}`;
    detail = "Ini catatan satu uji pada tanggal itu, bukan jaminan bahwa pemulihan akan berhasil hari ini. Ulangi secara berkala.";
  }

  const attention: string[] = [];
  const { exports: ex, cleanup: cl, capacity_requests: cap } = summary;
  if (ex.failed_30d > 0) attention.push(`${ex.failed_30d} export gagal dalam 30 hari terakhir.`);
  if (ex.stale_running > 0) attention.push(`${ex.stale_running} export berjalan lebih dari 2 jam (kemungkinan terhenti).`);
  if (cl.problem_runs_30d > 0) attention.push(`${cl.problem_runs_30d} pembersihan penyimpanan berakhir sebagian/gagal/terhenti dalam 30 hari terakhir.`);
  if (cl.stale_running > 0) attention.push(`${cl.stale_running} pembersihan penyimpanan masih berstatus berjalan padahal lease-nya sudah habis.`);
  if (cl.pending_objects > 0) attention.push(`${cl.pending_objects} objek penyimpanan menunggu dihapus atau perlu perhatian manual.`);
  if (cap.stale_pending > 0) attention.push(`${cap.stale_pending} permintaan kapasitas menunggu lebih dari 14 hari.`);
  const schemaMatches = summary.schema_version === EXPECTED_SCHEMA_VERSION;
  if (!schemaMatches) attention.push(`Versi skema database (${summary.schema_version}) berbeda dari yang diharapkan aplikasi (${EXPECTED_SCHEMA_VERSION}).`);
  for (const [label, result] of [["kunjungan tanpa invoice valid", reconciliation.unbilledVisits], ["invoice dan pembayaran tidak cocok", reconciliation.invoicePayments], ["sumber payroll bermasalah", reconciliation.payrollSources]] as const) {
    if (result.count !== null && result.count > 0) attention.push(`${result.capped ? `${result.count}+` : result.count} ${label} belum diselesaikan.`);
  }
  return {
    drillState, headline, detail, schemaMatches, attention,
    providerNote: "Status Supabase dan Vercel, jadwal backup, serta tagihan penyedia tidak dibaca oleh aplikasi ini. Periksa dashboard penyedia; prosedur pemulihan ada di runbook.",
  };
}
