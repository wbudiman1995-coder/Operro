import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { chunkPath, ORG_EXPORT_EXCLUDED, ORG_EXPORT_FORMAT, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, type ExportChunk, type ExportManifest, type ExportTable } from "@/lib/org-export-manifest";
import { verifyOrganizationExport, type ExportVerification } from "@/lib/org-export-verify";

const ARCHIVE_BUCKET = "organization-exports";
const CHUNK_SIZE = 200;
const DOWNLOAD_BATCH = 8;

type Work = { done: boolean; table_name?: string; after_id?: string | null; chunk_index?: number; archive_bucket: string; storage_prefix: string; include_storage: boolean };
type ChunkRow = { table_name: string; chunk_index: number; row_count: number; sha256: string; first_id: string; last_id: string; path: string };
type TableRow = { table_name: string; sort_order: number };
type StorageListing = { included: boolean; truncated: boolean; objects: unknown[] };
export type ExportJobSummary = { id: string; status: "running" | "completed" | "failed" | "cancelled"; include_storage: boolean; created_at: string; completed_at: string | null; failed_reason: string | null; manifest_sha256: string | null; tables_done: number; tables_total: number };

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
export async function verifyStoredOrganizationExport(supabase: SupabaseClient, jobId: string): Promise<ExportVerification & { manifestSha256: string | null }> {
  const manifest = await rpc<ExportManifest>(supabase, "org_export_manifest", { p_job: jobId });
  const files = await downloadAll(supabase, manifestPaths(manifest));
  return { ...verifyOrganizationExport(manifest, (path) => files.get(path) ?? null), manifestSha256: manifest.manifestSha256 };
}

export function describeExportError(error: unknown): string {
  const message = errorMessage(error);
  if (/not_authorized/.test(message)) return "Hanya pemilik bisnis yang dapat mengekspor data organisasi.";
  return message;
}
