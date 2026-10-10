/**
 * Function index:
 * - previewStorageCleanup: dry run (app.storage_cleanup_preview) - lists what an apply WOULD remove, removes nothing.
 * - runStorageCleanup: begin (metadata tombstoned first) -> remove objects -> record per-object outcome -> finish.
 * - listCleanupRuns: recent runs for the settings panel.
 *
 * Safety rules, enforced in the database and mirrored here:
 * - apply needs a fresh preview and only touches objects that preview listed and that are STILL eligible;
 * - the attachment row is tombstoned before any object is removed, so a crash leaves a retryable queue, not a dangling reference;
 * - an object is "missing" only when listing the folder succeeded and the name is absent; a listing error or a removal that
 *   did not actually remove the object (for example a Storage policy denial) is a FAILURE that is retried, never "missing";
 * - work per call is bounded (200 objects), and one run per organization holds a lease.
 * Nothing here estimates database bytes or touches billing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const CLEANUP_BATCH = 50;

export interface CleanupPreview { runId: string; candidates: number; items: Array<{ bucket: string; path: string; reason: string }> }
export interface PendingObject { item_id: string; bucket: string; path: string }
export type CleanupResult = { item_id: string; result: "deleted" | "missing" | "failed"; error?: string };
export interface CleanupSummary {
  runId: string; status: string; marked: number; skipped: number; deleted: number; missing: number; failed: number; error: string | null;
}

export async function previewStorageCleanup(supabase: SupabaseClient, organizationId: string, limit = 100): Promise<CleanupPreview> {
  const { data, error } = await supabase.schema("app").rpc("storage_cleanup_preview", { p_limit: limit });
  if (error) throw new Error(`storage_cleanup_preview_failed:${error.code ?? ""}:${error.message}`);
  const runId = String((data as { run_id: string }).run_id);
  const items = await supabase.from("storage_cleanup_items").select("storage_bucket,storage_path,reason")
    .eq("organization_id", organizationId).eq("run_id", runId).order("id").limit(200);
  if (items.error) throw new Error(`storage_cleanup_preview_items_failed:${items.error.message}`);
  return {
    runId, candidates: Number((data as { candidates: number }).candidates),
    items: (items.data ?? []).map((row) => ({ bucket: row.storage_bucket as string, path: row.storage_path as string, reason: row.reason as string })),
  };
}

type Outcome = "present" | "absent" | { error: string };

/** Presence check by listing the object's folder. Only a successful listing may conclude "absent". */
async function objectOutcome(supabase: SupabaseClient, bucket: string, path: string): Promise<Outcome> {
  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const { data, error } = await supabase.storage.from(bucket).list(folder, { limit: 100, search: name });
  if (error) return { error: `list: ${error.message}`.slice(0, 280) };
  return (data ?? []).some((entry) => entry.name === name) ? "present" : "absent";
}

export async function runStorageCleanup(supabase: SupabaseClient, dryRunId: string, options: { batch?: number } = {}): Promise<CleanupSummary> {
  const batch = Math.max(1, Math.min(options.batch ?? CLEANUP_BATCH, 100));
  const begun = await supabase.schema("app").rpc("storage_cleanup_begin", { p_dry_run: dryRunId });
  if (begun.error) throw new Error(`storage_cleanup_begin_failed:${begun.error.code ?? ""}:${begun.error.message}`);
  const start = begun.data as { run_id: string; marked: number; skipped: number; pending: PendingObject[] };
  const summary: CleanupSummary = { runId: start.run_id, status: "running", marked: start.marked, skipped: start.skipped, deleted: 0, missing: 0, failed: 0, error: null };

  try {
    for (let offset = 0; offset < start.pending.length; offset += batch) {
      const slice = start.pending.slice(offset, offset + batch);
      const results: CleanupResult[] = [];
      const toRemove = new Map<string, PendingObject[]>();
      for (const item of slice) {
        const outcome = await objectOutcome(supabase, item.bucket, item.path);
        if (outcome === "absent") results.push({ item_id: item.item_id, result: "missing" });
        else if (outcome === "present") toRemove.set(item.bucket, [...(toRemove.get(item.bucket) ?? []), item]);
        else results.push({ item_id: item.item_id, result: "failed", error: outcome.error });
      }
      for (const [bucket, items] of toRemove) {
        const removal = await supabase.storage.from(bucket).remove(items.map((item) => item.path));
        for (const item of items) {
          if (removal.error) { results.push({ item_id: item.item_id, result: "failed", error: `remove: ${removal.error.message}`.slice(0, 280) }); continue; }
          // Trust the Storage state, not the call: a policy denial can return success with nothing removed.
          const after = await objectOutcome(supabase, bucket, item.path);
          if (after === "absent") results.push({ item_id: item.item_id, result: "deleted" });
          else results.push({ item_id: item.item_id, result: "failed", error: after === "present" ? "object still present after removal" : after.error });
        }
      }
      const recorded = await supabase.schema("app").rpc("storage_cleanup_record", { p_run: start.run_id, p_results: results });
      if (recorded.error) throw new Error(`storage_cleanup_record_failed:${recorded.error.code ?? ""}:${recorded.error.message}`);
      for (const result of results) summary[result.result] += 1;
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message.slice(0, 280) : "unknown_error";
  } finally {
    const finished = await supabase.schema("app").rpc("storage_cleanup_finish", { p_run: start.run_id });
    summary.status = finished.error ? "unknown" : String(finished.data);
  }
  return summary;
}

export interface CleanupRunRow {
  id: string; mode: "dry_run" | "apply"; status: string; candidateCount: number; skippedCount: number; deletedCount: number;
  missingCount: number; failedCount: number; startedAt: string; finishedAt: string | null;
}
export async function listCleanupRuns(supabase: SupabaseClient, organizationId: string, limit = 10): Promise<CleanupRunRow[]> {
  const { data, error } = await supabase.from("storage_cleanup_runs")
    .select("id,mode,status,candidate_count,skipped_count,deleted_count,missing_count,failed_count,started_at,finished_at")
    .eq("organization_id", organizationId).order("started_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`storage_cleanup_runs_failed:${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id, mode: row.mode, status: row.status, candidateCount: row.candidate_count, skippedCount: row.skipped_count, deletedCount: row.deleted_count,
    missingCount: row.missing_count, failedCount: row.failed_count, startedAt: row.started_at, finishedAt: row.finished_at,
  }));
}
