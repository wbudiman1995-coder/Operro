/**
 * TEST TOOL. Builds an organization-export archive in the exact on-disk format of the application's exporter from rows that psql dumped
 * (one `to_jsonb(row)` per line, ordered by id) so the restore rehearsal can exercise the importer against a real PostgreSQL database
 * without a running application or Storage. It is not an export path for real data and is not used by the application.
 *
 *   npx tsx apps/web/scripts/build-fixture-archive.ts <dump-dir> <out-dir> <organization-id> <slug> <name>
 *
 * <dump-dir> holds `tables.txt` (table names in export order, one per line), `<table>.jsonl` for each, and `configuration.json`.
 * The layout produced is <out-dir>/<org>/exports/<job>/{manifest.json,configuration.json,tables/<table>/chunk-NNNNN.jsonl}.
 */
import fs from "node:fs";
import path from "node:path";

import { chunkPath, ORG_EXPORT_EXCLUDED, ORG_EXPORT_FORMAT, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, type ExportChunk, type ExportManifest, type ExportTable } from "../src/lib/org-export-manifest";

const CHUNK_SIZE = 200;

export function buildFixtureArchive(dumpDir: string, outDir: string, organizationId: string, slug: string, name: string, jobId = "00000000-0000-4000-8000-00000000f1f1"): string {
  const prefix = `${organizationId}/exports/${jobId}`;
  const jobFolder = path.join(outDir, ...prefix.split("/"));
  if (fs.existsSync(jobFolder)) throw new Error("output folder already exists");
  const tables: ExportTable[] = [];
  const names = fs.readFileSync(path.join(dumpDir, "tables.txt"), "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const table of names) {
    const lines = fs.readFileSync(path.join(dumpDir, `${table}.jsonl`), "utf8").split("\n").filter(Boolean);
    const chunks: ExportChunk[] = [];
    for (let start = 0, index = 0; start < lines.length; start += CHUNK_SIZE, index += 1) {
      const slice = lines.slice(start, start + CHUNK_SIZE);
      // The exporter re-serializes each row with JSON.stringify; do the same so the bytes (and hashes) are what it would write.
      const text = slice.map((line) => JSON.stringify(JSON.parse(line))).join("\n") + "\n";
      const rows = slice.map((line) => JSON.parse(line) as { id: string });
      const target = path.join(outDir, ...chunkPath(prefix, table, index).split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, "utf8");
      chunks.push({ index, rowCount: slice.length, sha256: sha256(text), path: chunkPath(prefix, table, index), firstId: rows[0].id, lastId: rows[rows.length - 1].id });
    }
    tables.push({ name: table, rowCount: chunks.reduce((total, chunk) => total + chunk.rowCount, 0), sha256: tableHash(chunks), chunks });
  }
  fs.mkdirSync(jobFolder, { recursive: true });
  const configuration = JSON.parse(fs.readFileSync(path.join(dumpDir, "configuration.json"), "utf8")) as Record<string, unknown>;
  const configText = stableJson(configuration);
  fs.writeFileSync(path.join(jobFolder, "configuration.json"), configText, "utf8");
  const manifest: ExportManifest = {
    format: ORG_EXPORT_FORMAT, version: ORG_EXPORT_VERSION, generatedAt: "2026-10-13T00:00:00.000Z",
    organization: { id: organizationId, slug, name }, configuration: { path: `${prefix}/configuration.json`, sha256: sha256(configText) },
    tables, storage: null, excluded: ORG_EXPORT_EXCLUDED, manifestSha256: null,
  };
  manifest.manifestSha256 = sha256(stableJson({ ...manifest, manifestSha256: null }));
  fs.writeFileSync(path.join(jobFolder, "manifest.json"), stableJson(manifest), "utf8");
  return jobFolder;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [dump, out, org, slug, name] = process.argv.slice(2);
  if (!dump || !out || !org || !slug || !name) {
    console.error("usage: build-fixture-archive <dump-dir> <out-dir> <organization-id> <slug> <name>");
    process.exit(2);
  }
  console.log(buildFixtureArchive(path.resolve(dump), path.resolve(out), org, slug, name));
}
