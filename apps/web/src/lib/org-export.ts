import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { chunkPath, ORG_EXPORT_EXCLUDED, ORG_EXPORT_FORMAT, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, type ExportChunk, type ExportManifest, type ExportTable } from "@/lib/org-export-manifest";
import { parseExportScope, type ExportScope } from "@/lib/org-export-scope";
import { verifyOrganizationExport, type ExportVerification } from "@/lib/org-export-verify";

const ARCHIVE_BUCKET = "organization-exports";
const CHUNK_SIZE = 200;
const DOWNLOAD_BATCH = 8;

type Work = { done: boolean; table_name?: string; after_id?: string | null; chunk_index?: number; archive_bucket: string; storage_prefix: string; include_storage: boolean };
type ChunkRow = { table_name: string; chunk_index: number; row_count: number; sha256: string; first_id: string; last_id: string; path: string };
type TableRow = { table_name: string; sort_order: number };
type StorageListing = { included: boolean; truncated: boolean; objects: unknown[] };
export type ExportJobSummary = {
  id: string; status: "running" | "completed" | "failed" | "cancelled"; include_storage: boolean; created_at: string; completed_at: string | null; failed_reason: string | null;
  manifest_sha256: string | null; tables_done: number; tables_total: number;
  /** Retention and the last recorded metadata verification (20261031130000). Absent on a database that predates it. */
  purged_at?: string | null; purged_files?: number | null; verified_at?: string | null; verified_ok?: boolean | null; verified_failures?: number | null;
};

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function rpc<T>(supabase: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await supabase.schema("app").rpc(name, args);
  if (result.error) throw Object.assign(new Error(`${name}_failed:${result.error.message}`), { code: result.error.code });
  return result.data as T;
}
// upsert: a chunk only becomes part of the archive when org_export_record_chunk commits it, so an
// interrupted attempt that uploaded but never recorded is safely overwritten by the retry.
async function put(supabase: SupabaseClient, path: string, text: string): Promise<void> {
  const upload = await supabase.storage.from(ARCHIVE_BUCKET).upload(path, new Blob([text], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  if (upload.error) throw new Error(`org_export_upload_failed:${upload.error.message}`);
}
async function downloadAll(supabase: SupabaseClient, paths: string[]): Promise<Map<string, string | null>> {
  const files = new Map<string, string | null>();
  for (let offset = 0; offset < paths.length; offset += DOWNLOAD_BATCH) {
    await Promise.all(paths.slice(offset, offset + DOWNLOAD_BATCH).map(async (path) => {
      const downloaded = await supabase.storage.from(ARCHIVE_BUCKET).download(path);
      files.set(path, downloaded.error || !downloaded.data ? null : await downloaded.data.text());
    }));
  }
  return files;
}
function manifestPaths(manifest: ExportManifest): string[] {
  return [manifest.configuration.path, ...manifest.tables.flatMap((table) => table.chunks.map((chunk) => chunk.path)), ...(manifest.storage ? [manifest.storage.path] : [])];
}

/** Starts a job, or resumes the organization's unfinished one (the database allows only one running job). */
export async function startOrganizationExport(supabase: SupabaseClient, includeStorage: boolean): Promise<{ jobId: string; resumed: boolean }> {
  const started = await rpc<{ job_id: string; resumed: boolean }>(supabase, "org_export_start", { p_include_storage: includeStorage });
  return { jobId: started.job_id, resumed: started.resumed };
}

export async function cancelOrganizationExport(supabase: SupabaseClient, jobId: string): Promise<void> {
  await rpc(supabase, "org_export_cancel", { p_job: jobId, p_reason: "cancelled_by_owner" });
}

/** `authorized: false` for anyone who is not the business owner (the database decides, not the page). */
export async function listOrganizationExports(supabase: SupabaseClient): Promise<{ authorized: boolean; jobs: ExportJobSummary[] }> {
  try { return { authorized: true, jobs: await rpc<ExportJobSummary[]>(supabase, "org_export_list", {}) }; }
  catch (error) {
    // A non-owner is the normal "not authorized" case. Anything else (e.g. migration not applied yet) must not take the storage page down.
    if ((error as { code?: string }).code !== "42501") console.error("org_export_list_failed", errorMessage(error));
    return { authorized: false, jobs: [] };
  }
}

export async function runOrganizationExportStep(supabase: SupabaseClient, jobId: string): Promise<{ done: boolean; message: string }> {
  const work = await rpc<Work>(supabase, "org_export_next_work", { p_job: jobId });
  if (work.done) { await finalizeOrganizationExport(supabase, jobId, work); return { done: true, message: "Export selesai. Hash dan jumlah baris tiap berkas sudah diperiksa ulang; arsip belum pernah diuji pemulihannya." }; }
  const tableName = work.table_name!;
  const rows = await rpc<Array<Record<string, unknown>>>(supabase, "org_export_table_page", { p_job: jobId, p_table: tableName, p_after_id: work.after_id ?? null, p_limit: CHUNK_SIZE });
  if (rows.length === 0) {
    await rpc(supabase, "org_export_finish_table", { p_job: jobId, p_table: tableName, p_after_id: work.after_id ?? null });
    return { done: false, message: `${tableName}: selesai.` };
  }
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const firstId = String(rows[0].id); const lastId = String(rows[rows.length - 1].id);
  const path = chunkPath(work.storage_prefix, tableName, work.chunk_index!);
  await put(supabase, path, text);
  await rpc(supabase, "org_export_record_chunk", { p_job: jobId, p_table: tableName, p_index: work.chunk_index, p_row_count: rows.length, p_sha256: sha256(text), p_first_id: firstId, p_last_id: lastId, p_storage_path: path });
  return { done: false, message: `${tableName}: ${rows.length} baris.` };
}

async function finalizeOrganizationExport(supabase: SupabaseClient, jobId: string, work: Work): Promise<void> {
  const [configuration, storage, chunks, tables] = await Promise.all([
    rpc<Record<string, unknown>>(supabase, "org_export_configuration", {}),
    rpc<StorageListing>(supabase, "org_export_storage_listing", { p_job: jobId }),
    rpc<ChunkRow[]>(supabase, "org_export_chunks", { p_job: jobId }),
    rpc<TableRow[]>(supabase, "org_export_tables", { p_job: jobId }),
  ]);
  const configPath = `${work.storage_prefix}/configuration.json`; const configText = stableJson(configuration); await put(supabase, configPath, configText);
  let storageManifest: ExportManifest["storage"] = null;
  if (storage.included) { const path = `${work.storage_prefix}/storage-listing.json`; const text = stableJson(storage); await put(supabase, path, text); storageManifest = { path, sha256: sha256(text), objectCount: storage.objects.length, truncated: storage.truncated }; }
  const exportTables: ExportTable[] = tables.sort((a, b) => a.sort_order - b.sort_order).map((table) => {
    const tableChunks: ExportChunk[] = chunks.filter((chunk) => chunk.table_name === table.table_name).sort((a, b) => a.chunk_index - b.chunk_index).map((chunk) => ({ index: chunk.chunk_index, rowCount: chunk.row_count, sha256: chunk.sha256, path: chunk.path, firstId: chunk.first_id, lastId: chunk.last_id }));
    return { name: table.table_name, rowCount: tableChunks.reduce((total, chunk) => total + chunk.rowCount, 0), sha256: tableHash(tableChunks), chunks: tableChunks };
  });
  const manifest: ExportManifest = { format: ORG_EXPORT_FORMAT, version: ORG_EXPORT_VERSION, generatedAt: new Date().toISOString(), organization: { id: String(configuration.id), slug: String(configuration.slug), name: String(configuration.name) }, configuration: { path: configPath, sha256: sha256(configText) }, tables: exportTables, storage: storageManifest, excluded: ORG_EXPORT_EXCLUDED, manifestSha256: null };
  manifest.manifestSha256 = sha256(stableJson({ ...manifest, manifestSha256: null }));
  await put(supabase, `${work.storage_prefix}/manifest.json`, stableJson(manifest));
  const files = await downloadAll(supabase, manifestPaths(manifest));
  const verification = verifyOrganizationExport(manifest, (path) => files.get(path) ?? null);
  if (!verification.ok) throw new Error(`org_export_verification_failed:${verification.failures.slice(0, 5).join(",")}`);
  await rpc(supabase, "org_export_complete", { p_job: jobId, p_manifest: manifest });
}

/** Dry-run verification of a completed archive: re-reads and re-hashes its files. Restores nothing. */
export async function verifyStoredOrganizationExport(supabase: SupabaseClient, jobId: string): Promise<ExportVerification & { manifestSha256: string | null; recorded: boolean }> {
  const manifest = await rpc<ExportManifest>(supabase, "org_export_manifest", { p_job: jobId });
  const files = await downloadAll(supabase, manifestPaths(manifest));
  const result = verifyOrganizationExport(manifest, (path) => files.get(path) ?? null);
  // Remember the outcome so health and the job list can say "never verified" or "last verification failed". Best effort:
  // a recording failure must not turn a finished verification into an error, and the result is the application's own record.
  let recorded = false;
  try { await rpc(supabase, "org_export_record_verification", { p_job: jobId, p_ok: result.ok, p_failure_count: result.failures.length }); recorded = true; }
  catch (error) { console.error("org_export_record_verification_failed", errorMessage(error)); }
  return { ...result, manifestSha256: manifest.manifestSha256, recorded };
}

/** Live scope of the archive (owner only): allowlisted tables with row counts, and every other tenant table with a reason. */
export async function loadExportScope(supabase: SupabaseClient): Promise<ExportScope | null> {
  try { return parseExportScope(await rpc<unknown>(supabase, "org_export_scope", {})); }
  catch (error) {
    if ((error as { code?: string }).code !== "42501") console.error("org_export_scope_failed", errorMessage(error));
    return null;
  }
}

/** The manifest of a completed, not purged archive, or null (never throws: used only for display). */
export async function readCompletedManifest(supabase: SupabaseClient, jobId: string): Promise<ExportManifest | null> {
  try { return await rpc<ExportManifest>(supabase, "org_export_manifest", { p_job: jobId }); }
  catch (error) { console.error("org_export_manifest_read_failed", errorMessage(error)); return null; }
}

export type PurgeCandidate = { id: string; status: string; created_at: string; storage_prefix: string };
export async function listPurgeCandidates(supabase: SupabaseClient): Promise<PurgeCandidate[]> {
  try { return await rpc<PurgeCandidate[]>(supabase, "org_export_purge_candidates", {}); }
  catch (error) {
    if ((error as { code?: string }).code !== "42501") console.error("org_export_purge_candidates_failed", errorMessage(error));
    return [];
  }
}

const PURGE_LIST_PAGE = 1000;
const PURGE_REMOVE_BATCH = 100;
const PURGE_MAX_FILES_PER_CALL = 5000;

async function listArchiveFiles(supabase: SupabaseClient, prefix: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const queue = [prefix];
  for (let guard = 0; queue.length > 0 && files.length < limit; guard += 1) {
    if (guard > 5000) throw new Error("org_export_purge_too_many_folders");
    const dir = queue.shift()!;
    for (let offset = 0; files.length < limit; offset += PURGE_LIST_PAGE) {
      const listed = await supabase.storage.from(ARCHIVE_BUCKET).list(dir, { limit: PURGE_LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (listed.error) throw new Error(`org_export_purge_list_failed:${listed.error.message}`);
      for (const item of listed.data ?? []) {
        if (item.id === null || item.id === undefined) queue.push(`${dir}/${item.name}`); else files.push(`${dir}/${item.name}`);
      }
      if ((listed.data?.length ?? 0) < PURGE_LIST_PAGE) break;
    }
  }
  return files;
}

/**
 * Removes the files of one purge-candidate archive from Storage (owner session; the delete policy is scoped to the
 * archive prefix) and, only when a fresh listing shows nothing left, records the purge. Safe to repeat: an interrupted or
 * partial run is simply resumed. A removal that Storage reports as successful but that left the object in place (policy
 * denial) is detected by the re-listing and reported, never recorded as done.
 */
export async function purgeExportArchive(supabase: SupabaseClient, jobId: string): Promise<{ done: boolean; removed: number }> {
  const candidates = await listPurgeCandidates(supabase);
  const job = candidates.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("org_export_not_purgeable");
  const prefix = job.storage_prefix;
  if (!/^[0-9a-f-]{36}\/exports\/[0-9a-f-]{36}$/i.test(prefix)) throw new Error("org_export_prefix_invalid");
  let removed = 0;
  const files = await listArchiveFiles(supabase, prefix, PURGE_MAX_FILES_PER_CALL);
  for (let offset = 0; offset < files.length; offset += PURGE_REMOVE_BATCH) {
    const batch = files.slice(offset, offset + PURGE_REMOVE_BATCH);
    const result = await supabase.storage.from(ARCHIVE_BUCKET).remove(batch);
    if (result.error) throw new Error(`org_export_purge_remove_failed:${result.error.message}`);
    removed += result.data?.length ?? 0;
  }
  const left = await listArchiveFiles(supabase, prefix, 1);
  if (left.length > 0) {
    if (removed === 0) throw new Error("org_export_purge_blocked");
    return { done: false, removed };
  }
  await rpc(supabase, "org_export_mark_purged", { p_job: jobId, p_files: removed });
  return { done: true, removed };
}

export function describeExportError(error: unknown): string {
  const message = errorMessage(error);
  if (/not_authorized/.test(message)) return "Hanya pemilik bisnis yang dapat mengekspor data organisasi.";
  if (/job_purged/.test(message)) return "Berkas arsip ini sudah dihapus (masa simpan), sehingga tidak dapat diverifikasi.";
  if (/org_export_not_purgeable/.test(message)) return "Arsip ini bukan kandidat penghapusan (masih dalam masa simpan, atau arsip selesai terbaru).";
  if (/org_export_purge_blocked/.test(message)) return "Penyimpanan menolak penghapusan berkas. Arsip tidak ditandai terhapus.";
  return message;
}
