import { chunkPath, FORBIDDEN_EXPORT_KEY, ORG_EXPORT_FORMAT, ORG_EXPORT_STORAGE_BUCKETS, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, type ExportManifest } from "./org-export-manifest";

export type ExportVerification = { ok: boolean; failures: string[]; warnings: string[] };
type Row = Record<string, unknown>;

function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function forbiddenKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).filter((key) => FORBIDDEN_EXPORT_KEY.test(key)) : [];
}

/**
 * Metadata-only dry run: re-reads every file the manifest names and checks hashes, row counts,
 * tenant, ordering, deterministic paths and forbidden keys. It restores nothing and does not
 * prove the archive can be restored.
 */
export function verifyOrganizationExport(manifest: unknown, read: (path: string) => string | null): ExportVerification {
  const failures: string[] = []; const warnings: string[] = [];
  if (!manifest || typeof manifest !== "object") return { ok: false, failures: ["manifest_missing"], warnings };
  const archive = manifest as Partial<ExportManifest>;
  if (archive.format !== ORG_EXPORT_FORMAT || archive.version !== ORG_EXPORT_VERSION) failures.push("format_unsupported");
  const orgId = archive.organization?.id;
  if (!orgId) failures.push("organization_missing");
  if (!Array.isArray(archive.excluded)) failures.push("excluded_missing");
  const configPath = archive.configuration?.path ?? "";
  const jobPrefix = configPath.endsWith("/configuration.json") ? configPath.slice(0, -"/configuration.json".length) : "";
  if (!orgId || !jobPrefix.startsWith(`${orgId}/exports/`) || jobPrefix.includes("..")) failures.push("archive_prefix_invalid");

  const names = new Set<string>();
  for (const table of archive.tables ?? []) {
    if (names.has(table.name)) failures.push(`table_duplicate:${table.name}`); names.add(table.name);
    let rows = 0; let previousLast: string | null = null;
    (table.chunks ?? []).forEach((chunk, position) => {
      if (chunk.index !== position) failures.push(`chunk_index_invalid:${table.name}:${chunk.index}`);
      if (chunk.path !== chunkPath(jobPrefix, table.name, chunk.index)) failures.push(`chunk_path_invalid:${chunk.path}`);
      if (!(chunk.rowCount >= 1 && chunk.rowCount <= 200)) failures.push(`chunk_row_bound:${chunk.path}`);
      const text = read(chunk.path); if (text === null) { failures.push(`chunk_missing:${chunk.path}`); return; }
      if (sha256(text) !== chunk.sha256) failures.push(`chunk_hash_mismatch:${chunk.path}`);
      const parsed = text.split("\n").filter(Boolean).map((line) => { const row = parseJson(line); if (!row || typeof row !== "object") failures.push(`chunk_invalid_json:${chunk.path}`); return row as Row | undefined; });
      if (parsed.length !== chunk.rowCount) failures.push(`chunk_row_count_mismatch:${chunk.path}`);
      let last: string | null = previousLast;
      for (const row of parsed) {
        if (!row) continue;
        if (row.organization_id !== orgId) failures.push(`tenant_mismatch:${chunk.path}`);
        const id = typeof row.id === "string" ? row.id : null;
        if (!id || (last !== null && id <= last)) failures.push(`row_order_invalid:${chunk.path}`); else last = id;
        if (forbiddenKeys(row).length) failures.push(`forbidden_key:${chunk.path}`);
      }
      const first = parsed[0]?.id; const lastRow = parsed[parsed.length - 1]?.id;
      if (first !== chunk.firstId || lastRow !== chunk.lastId) failures.push(`chunk_id_range_mismatch:${chunk.path}`);
      previousLast = last; rows += parsed.length;
    });
    if (rows !== table.rowCount) failures.push(`table_row_count_mismatch:${table.name}`);
    if (tableHash(table.chunks ?? []) !== table.sha256) failures.push(`table_hash_mismatch:${table.name}`);
  }

  for (const artifact of [archive.configuration, archive.storage]) if (artifact) {
    if (!artifact.path.startsWith(`${jobPrefix}/`) || artifact.path.includes("..")) failures.push(`artifact_path_invalid:${artifact.path}`);
    const text = read(artifact.path); if (text === null) failures.push(`artifact_missing:${artifact.path}`);
    else if (sha256(text) !== artifact.sha256) failures.push(`artifact_hash_mismatch:${artifact.path}`);
  }
  const config = archive.configuration && read(archive.configuration.path);
  if (config) {
    const parsed = parseJson(config) as Row | undefined;
    if (!parsed || parsed.id !== orgId) failures.push("configuration_tenant_mismatch");
    else if (forbiddenKeys(parsed).length || forbiddenKeys(parsed.settings).length || "platform_billing" in ((parsed.settings as Row | undefined) ?? {})) failures.push("configuration_forbidden_key");
  }
  const listing = archive.storage && read(archive.storage.path);
  if (listing) {
    const parsed = parseJson(listing) as { objects?: Row[]; truncated?: boolean } | undefined;
    const objects = Array.isArray(parsed?.objects) ? parsed.objects : null;
    if (!objects || objects.length !== archive.storage?.objectCount) failures.push("storage_listing_count_mismatch");
    for (const object of objects ?? []) {
      const bucket = String(object.bucket); const name = String(object.name);
      if (!(ORG_EXPORT_STORAGE_BUCKETS as readonly string[]).includes(bucket) || !name.startsWith(`${orgId}/`)) failures.push(`storage_listing_tenant_mismatch:${bucket}/${name}`);
      if (Object.keys(object).some((key) => /url|token|signed/i.test(key))) failures.push("storage_listing_forbidden_key");
    }
    if (archive.storage?.truncated) warnings.push("storage_listing_truncated");
  }
  if (!archive.storage) warnings.push("storage_listing_not_requested");
  if (!archive.manifestSha256 || sha256(stableJson({ ...archive, manifestSha256: null })) !== archive.manifestSha256) failures.push("manifest_hash_mismatch");
  return { ok: failures.length === 0, failures, warnings };
}
