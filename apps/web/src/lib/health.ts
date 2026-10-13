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
import { summarizeScope, type ExportScope } from "@/lib/org-export-scope";
import { loadInvoicePaymentIssues, loadUnbilledVisits, scanPayrollSources } from "@/lib/reconciliation";

export const EXPECTED_SCHEMA_VERSION = "20261101130000";
export const DRILL_FRESH_DAYS = 90;
export const RECONCILIATION_COUNT_CAP = 100;

export interface HealthSummary {
  schema_version: string;
  generated_at: string;
  exports: {
    failed_30d: number; stale_running: number; last_completed_at: string | null; last_failure_at: string | null;
    /** Added by 20261101130000; absent on an older database, in which case the signals below are simply not derived. */
    completed_archives?: number; newest_completed_at?: string | null; unverified_completed?: number; last_verification_ok?: boolean | null; purge_candidates?: number;
  };
  cleanup: { problem_runs_30d: number; stale_running: number; last_apply_status: string | null; last_apply_at: string | null; pending_objects: number; schedule_consent?: boolean };
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

export interface OwnerAction {
  id: string;
  /** attention = something is wrong or unproven; info = housekeeping the owner may want to do. */
  severity: "attention" | "info";
  text: string;
  label: string;
  /** An in-app page that already lets the owner do it; null when the action happens outside the application. */
  href: string | null;
}

const ARCHIVE_STALE_DAYS = 30;

/**
 * Every unresolved reliability finding paired with the concrete thing the owner does about it. Pure; built only from
 * records Operro stores (export jobs, cleanup runs, reconciliation counts, the export scope report, recorded drills).
 */
export function deriveOwnerActions(summary: HealthSummary, recovery: RecoveryStatus, reconciliation: ReconciliationCounts, scope: ExportScope | null, now = new Date()): OwnerAction[] {
  const actions: OwnerAction[] = [];
  const storage = "/settings/storage";
  const { exports: ex, cleanup: cl, capacity_requests: cap } = summary;
  if (ex.failed_30d > 0) actions.push({ id: "export_failed", severity: "attention", text: `${ex.failed_30d} export gagal dalam 30 hari terakhir.`, label: "Buka Data & penyimpanan dan ulangi export", href: storage });
  if (ex.stale_running > 0) actions.push({ id: "export_stalled", severity: "attention", text: `${ex.stale_running} export berjalan lebih dari 2 jam (kemungkinan terhenti).`, label: "Lanjutkan atau batalkan export", href: storage });
  if (ex.completed_archives !== undefined) {
    if (ex.completed_archives === 0) actions.push({ id: "export_none", severity: "info", text: "Belum ada arsip export yang selesai dan masih tersimpan.", label: "Buat export organisasi", href: storage });
    else if (ex.last_verification_ok === false) actions.push({ id: "export_verification_failed", severity: "attention", text: "Verifikasi metadata terakhir gagal: arsip tersimpan mungkin rusak atau tidak lengkap.", label: "Buat export baru lalu verifikasi", href: storage });
    else if ((ex.unverified_completed ?? 0) > 0) actions.push({ id: "export_unverified", severity: "attention", text: `${ex.unverified_completed} arsip selesai belum pernah diverifikasi.`, label: "Jalankan Verifikasi metadata", href: storage });
    if (ex.newest_completed_at && (now.getTime() - Date.parse(ex.newest_completed_at)) / 86_400_000 > ARCHIVE_STALE_DAYS) actions.push({ id: "export_old", severity: "info", text: `Arsip terbaru berusia lebih dari ${ARCHIVE_STALE_DAYS} hari; perubahan sejak itu tidak ada di dalamnya.`, label: "Buat export baru", href: storage });
  }
  if ((ex.purge_candidates ?? 0) > 0) actions.push({ id: "export_purge", severity: "info", text: `${ex.purge_candidates} arsip melewati masa simpan dan berkasnya masih memakai penyimpanan.`, label: "Hapus berkas arsip lama", href: storage });
  if (scope) {
    const open = summarizeScope(scope).unreviewedWithData;
    if (open > 0) actions.push({ id: "scope_gap", severity: "attention", text: `${open} tabel berisi data tetapi belum masuk arsip export; arsip belum salinan lengkap organisasi.`, label: "Tinjau cakupan arsip", href: storage });
  }
  if (cl.problem_runs_30d > 0) actions.push({ id: "cleanup_problem", severity: "attention", text: `${cl.problem_runs_30d} pembersihan penyimpanan berakhir sebagian/gagal/terhenti dalam 30 hari terakhir.`, label: "Buat pratinjau dan jalankan ulang pembersihan", href: storage });
  if (cl.stale_running > 0) actions.push({ id: "cleanup_stalled", severity: "attention", text: `${cl.stale_running} pembersihan masih berstatus berjalan padahal lease-nya habis.`, label: "Jalankan pembersihan lagi (lease lama diambil alih)", href: storage });
  if (cl.pending_objects > 0) actions.push({ id: "cleanup_pending", severity: "attention", text: `${cl.pending_objects} objek penyimpanan menunggu dihapus atau perlu perhatian manual.`, label: "Jalankan pembersihan sesuai pratinjau", href: storage });
  if (cl.schedule_consent === true) actions.push({ id: "cleanup_consent_no_runner", severity: "info", text: "Persetujuan pembersihan otomatis tercatat, tetapi belum ada penjadwal; tidak ada yang berjalan otomatis.", label: "Tinjau atau matikan persetujuan", href: storage });
  for (const [id, label, result] of [["unbilled", "kunjungan selesai tanpa invoice valid", reconciliation.unbilledVisits], ["invoice_payment", "invoice dan pembayaran tidak cocok", reconciliation.invoicePayments], ["payroll_source", "sumber payroll bermasalah", reconciliation.payrollSources]] as const) {
    if (result.count !== null && result.count > 0) actions.push({ id: `reconcile_${id}`, severity: "attention", text: `${result.capped ? `${result.count}+` : result.count} ${label} belum diselesaikan.`, label: "Tinjau di Rekonsiliasi", href: "/reconciliation" });
  }
  if (cap.stale_pending > 0) actions.push({ id: "capacity_waiting", severity: "info", text: `${cap.stale_pending} permintaan kapasitas menunggu lebih dari 14 hari.`, label: "Hubungi Operro untuk menindaklanjuti", href: null });
  if (summary.schema_version !== EXPECTED_SCHEMA_VERSION) actions.push({ id: "schema_mismatch", severity: "attention", text: `Versi skema database (${summary.schema_version}) berbeda dari yang diharapkan aplikasi (${EXPECTED_SCHEMA_VERSION}).`, label: "Minta pemilik platform menerapkan migrasi atau memutar balik aplikasi", href: null });
  const drill = deriveReadiness(summary, recovery, reconciliation, now).drillState;
  if (drill !== "recent_pass") actions.push({ id: "drill", severity: "attention", text: drill === "never" ? "Pemulihan belum pernah dibuktikan dengan uji ke proyek percobaan." : drill === "stale" ? "Bukti uji pemulihan sudah kedaluwarsa." : "Uji pemulihan terakhir tidak lulus.", label: "Minta pemilik platform menjalankan runbook DISPOSABLE_RESTORE_DRILL dan mencatat hasilnya", href: null });
  return actions;
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
