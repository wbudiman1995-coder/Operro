import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { before } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { chunkPath, ORG_EXPORT_FORMAT, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, type ExportManifest } from "../src/lib/org-export-manifest";
import { compareManifestToScope, parseExportScope, summarizeScope, UNCOVERED_CLASS_LABELS, UNCOVERED_CLASSES } from "../src/lib/org-export-scope";
import type { ExportJobSummary } from "../src/lib/org-export";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

// Real components render without the Next.js runtime; Server Action modules are stubbed (contract-level evidence).
const STUBBED = new Set(["@/app/settings/storage/export-actions"]);
const inert = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : name === "then" ? undefined : async () => ({ ok: true, message: "" })) });
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;
let lib: typeof import("../src/lib/org-export");
let Panel: typeof import("../src/components/organization-export-panel").OrganizationExportPanel;
let ScopePanel: typeof import("../src/components/export-scope-panel").ExportScopePanel;
before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    if (STUBBED.has(request)) return inert;
    return originalLoad.call(this, request, parent, isMain);
  };
  lib = await import("../src/lib/org-export");
  ({ OrganizationExportPanel: Panel } = await import("../src/components/organization-export-panel"));
  ({ ExportScopePanel: ScopePanel } = await import("../src/components/export-scope-panel"));
});

const rawScope = {
  generated_at: "2026-10-12T00:00:00Z", fingerprint: "ab".repeat(32),
  included: [{ table: "customers", sort_order: 30, reason: "customer records", row_count: 12 }, { table: "payments", sort_order: 168, reason: "payments", row_count: "40" }, { sort_order: 1 }],
  uncovered: [
    { table: "customer_onboarding_links", row_count: 2, capped: false, class: "secret" },
    { table: "inventory_movements", row_count: 10000, capped: true, class: "not_reviewed" },
    { table: "grooming_jobs", row_count: 3, capped: false, class: "no_uuid_cursor" },
    { table: "weird", row_count: 1, capped: false, class: "made_up" },
    { table: "empty_unreviewed", row_count: 0, capped: false, class: "not_reviewed" },
  ],
  retention: { failed_or_cancelled_days: 7, completed_days: 90, keeps_newest_completed: true },
};

test("scope parsing is defensive: junk rows dropped, unknown classes degrade to not_reviewed, numbers coerced", () => {
  const scope = parseExportScope(rawScope)!;
  assert.deepEqual(scope.included.map((entry) => [entry.table, entry.rowCount]), [["customers", 12], ["payments", 40]]);
  assert.equal(scope.uncovered.find((entry) => entry.table === "weird")?.cls, "not_reviewed");
  assert.equal(scope.uncovered.find((entry) => entry.table === "inventory_movements")?.capped, true);
  for (const bad of [null, undefined, {}, { included: [], uncovered: [] }, "x"]) assert.equal(parseExportScope(bad), null);
  assert.equal(Object.keys(UNCOVERED_CLASS_LABELS).length, UNCOVERED_CLASSES.length);
});

test("summary counts classes and flags unreviewed tables that actually hold data", () => {
  const summary = summarizeScope(parseExportScope(rawScope)!);
  assert.equal(summary.includedTables, 2);
  assert.equal(summary.includedRows, 52);
  assert.equal(summary.uncoveredByClass.secret, 1);
  assert.equal(summary.unreviewedWithData, 3, "inventory_movements, grooming_jobs, weird (unknown class) and not the empty one");
});

function manifest(tables: Array<[string, number]>): ExportManifest {
  const exportTables = tables.map(([name, rowCount]) => ({ name, rowCount, sha256: tableHash([]), chunks: [] }));
  const m: ExportManifest = { format: ORG_EXPORT_FORMAT, version: ORG_EXPORT_VERSION, generatedAt: "t", organization: { id: "o", slug: "o", name: "O" }, configuration: { path: "p", sha256: "h" }, tables: exportTables, storage: null, excluded: [], manifestSha256: null };
  m.manifestSha256 = sha256(stableJson({ ...m, manifestSha256: null }));
  return m;
}

test("drift compares an old archive with the workspace now, per table, and names tables the archive predates", () => {
  const scope = parseExportScope(rawScope)!;
  const drift = compareManifestToScope(manifest([["customers", 10], ["payments", 40], ["legacy_only", 5]]), scope);
  assert.deepEqual(drift.rows, [{ table: "customers", exported: 10, current: 12, delta: 2 }, { table: "payments", exported: 40, current: 40, delta: 0 }]);
  assert.equal(drift.changed, 1);
  assert.deepEqual(compareManifestToScope(manifest([["customers", 12]]), scope).notInArchive, ["payments"]);
});

test("scope panel: unreviewed data is called out as NOT in the archive; no scope is an honest unavailable state, never a clean one", () => {
  const scope = parseExportScope(rawScope)!;
  const html = renderToStaticMarkup(<ScopePanel scope={scope} drift={compareManifestToScope(manifest([["customers", 10]]), scope)} driftJobDate="10/10/2026" />);
  assert.match(html, /3 tabel berisi data tetapi <strong>belum masuk arsip<\/strong>/);
  assert.match(html, /inventory_movements \(10\.000\+\)/);
  assert.match(html, /belum merupakan salinan lengkap organisasi/);
  assert.match(html, /Isi file Storage, akun login, hak akses, dan rahasia penyedia tidak ikut/);
  assert.match(html, /1 tabel berubah sejak arsip dibuat/);
  assert.match(html, /customers: 10 → 12 \(\+2\)/);
  assert.match(html, /Tabel yang belum ada di arsip itu: payments/);
  assert.match(html, /arsip selesai terbaru selalu dipertahankan/);
  assert.doesNotMatch(html, /backup|cadangan lengkap|aman dipulihkan/i);
  const none = renderToStaticMarkup(<ScopePanel scope={null} drift={null} driftJobDate={null} />);
  assert.match(none, /Cakupan arsip belum dapat dimuat/);
  assert.match(none, /bukan tanda bahwa semua data tercakup/);
});

const job = (extra: Partial<ExportJobSummary> = {}): ExportJobSummary => ({ id: "11111111-1111-4111-8111-111111111111", status: "completed", include_storage: true, created_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:05:00Z", failed_reason: null, manifest_sha256: "ab", tables_done: 42, tables_total: 42, ...extra });

test("export panel: verification state, purge button only for candidates, purged archives lose verify", () => {
  const never = renderToStaticMarkup(<Panel authorized jobs={[job()]} />);
  assert.match(never, /belum diverifikasi/);
  assert.match(never, /Verifikasi metadata/);
  assert.doesNotMatch(never, /Hapus berkas/);
  const ok = renderToStaticMarkup(<Panel authorized jobs={[job({ verified_at: "2026-10-02T00:00:00Z", verified_ok: true, verified_failures: 0 })]} />);
  assert.match(ok, /metadata terverifikasi/);
  const failed = renderToStaticMarkup(<Panel authorized jobs={[job({ verified_at: "2026-10-02T00:00:00Z", verified_ok: false, verified_failures: 3 })]} />);
  assert.match(failed, /verifikasi GAGAL[^<]*\(3 temuan\)/);
  const purgeable = renderToStaticMarkup(<Panel authorized jobs={[job()]} purgeable={["11111111-1111-4111-8111-111111111111"]} />);
  assert.match(purgeable, /Hapus berkas \(melewati masa simpan\)/);
  const purged = renderToStaticMarkup(<Panel authorized jobs={[job({ purged_at: "2026-10-05T00:00:00Z" })]} purgeable={["11111111-1111-4111-8111-111111111111"]} />);
  assert.match(purged, /berkas dihapus/);
  assert.doesNotMatch(purged, /Verifikasi metadata|belum diverifikasi/);
  assert.match(renderToStaticMarkup(<Panel authorized jobs={[job()]} />), /bukan cadangan/);
  assert.match(renderToStaticMarkup(<Panel authorized={false} jobs={[]} />), /Hanya pemilik bisnis/);
});

/** Fake Storage: a folder tree, a policy switch that makes remove() "succeed" without removing, and an RPC recorder. */
function fakeStorage(files: string[], options: { denyRemoval?: boolean; candidate?: { id: string; storage_prefix: string } | null } = {}) {
  const present = new Set(files);
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const removed: string[][] = [];
  const bucket = {
    list: async (dir: string, opts: { limit: number; offset: number }) => {
      const children = new Map<string, boolean>();
      for (const file of present) {
        if (!file.startsWith(`${dir}/`)) continue;
        const rest = file.slice(dir.length + 1);
        const slash = rest.indexOf("/");
        children.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0);
      }
      const all = [...children].sort(([a], [b]) => a.localeCompare(b)).map(([name, isFile]) => ({ name, id: isFile ? `id-${name}` : null }));
      return { data: all.slice(opts.offset, opts.offset + opts.limit), error: null };
    },
    remove: async (paths: string[]) => {
      removed.push(paths);
      if (options.denyRemoval) return { data: [], error: null };
      for (const p of paths) present.delete(p);
      return { data: paths.map((name) => ({ name })), error: null };
    },
  };
  const client = {
    storage: { from: () => bucket },
    schema: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "org_export_purge_candidates") return { data: options.candidate === null ? [] : [{ id: options.candidate?.id ?? "j1", status: "failed", created_at: "x", storage_prefix: options.candidate?.storage_prefix ?? PREFIX }], error: null };
      return { data: null, error: null };
    } }),
  };
  return { client: client as never, present, rpcCalls, removed };
}
const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PREFIX = `${ORG}/exports/${JOB}`;
const archiveFiles = () => [`${PREFIX}/manifest.json`, `${PREFIX}/configuration.json`, ...Array.from({ length: 130 }, (_, i) => `${PREFIX}/tables/customers/${chunkPath("x", "c", i).split("/").pop()}`), `${PREFIX}/tables/pets/chunk-00000.jsonl`];

test("purge removes every file in batches, re-lists, and only then records it", async () => {
  const storage = fakeStorage(archiveFiles(), { candidate: { id: "j1", storage_prefix: PREFIX } });
  const result = await lib.purgeExportArchive(storage.client, "j1");
  assert.deepEqual([result.done, result.removed], [true, 133]);
  assert.equal(storage.present.size, 0);
  assert.ok(storage.removed.every((batch) => batch.length <= 100), "removed in batches of at most 100");
  assert.ok(storage.removed.flat().every((p) => p.startsWith(`${PREFIX}/`)), "only files under the archive prefix");
  const mark = storage.rpcCalls.filter((call) => call.name === "org_export_mark_purged");
  assert.equal(mark.length, 1);
  assert.deepEqual(mark[0].args, { p_job: "j1", p_files: 133 });
});

test("purge: a removal that storage reports as ok but did not happen is detected and never recorded", async () => {
  const storage = fakeStorage(archiveFiles(), { denyRemoval: true, candidate: { id: "j1", storage_prefix: PREFIX } });
  await assert.rejects(() => lib.purgeExportArchive(storage.client, "j1"), /org_export_purge_blocked/);
  assert.equal(storage.present.size, 133);
  assert.ok(!storage.rpcCalls.some((call) => call.name === "org_export_mark_purged"));
  assert.match(lib.describeExportError(new Error("org_export_purge_blocked")), /menolak penghapusan/);
});

test("purge: a job that is not a candidate, or a malformed prefix, touches nothing", async () => {
  const none = fakeStorage(archiveFiles(), { candidate: null });
  await assert.rejects(() => lib.purgeExportArchive(none.client, "j1"), /org_export_not_purgeable/);
  assert.equal(none.removed.length, 0);
  const evil = fakeStorage(archiveFiles(), { candidate: { id: "j1", storage_prefix: "../../other-org/exports/x" } });
  await assert.rejects(() => lib.purgeExportArchive(evil.client, "j1"), /org_export_prefix_invalid/);
  assert.equal(evil.removed.length, 0);
  const idempotent = fakeStorage([], { candidate: { id: "j1", storage_prefix: PREFIX } });
  assert.deepEqual(await lib.purgeExportArchive(idempotent.client, "j1"), { done: true, removed: 0 }, "an already-empty prefix is simply recorded");
});

test("verifying an archive records the result without changing it; a recording failure never hides the verification", async () => {
  const rows = '{"id":"a","organization_id":"o"}\n';
  const chunk = { index: 0, rowCount: 1, sha256: sha256(rows), path: chunkPath("o/exports/j", "customers", 0), firstId: "a", lastId: "a" };
  const config = JSON.stringify({ id: "o", settings: {} });
  const m: ExportManifest = { format: ORG_EXPORT_FORMAT, version: ORG_EXPORT_VERSION, generatedAt: "t", organization: { id: "o", slug: "o", name: "O" }, configuration: { path: "o/exports/j/configuration.json", sha256: sha256(config) }, tables: [{ name: "customers", rowCount: 1, sha256: tableHash([chunk]), chunks: [chunk] }], storage: null, excluded: [], manifestSha256: null };
  m.manifestSha256 = sha256(stableJson({ ...m, manifestSha256: null }));
  const files = new Map([[chunk.path, rows], [m.configuration.path, config]]);
  const make = (recordFails: boolean) => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        storage: { from: () => ({ download: async (p: string) => (files.has(p) ? { data: new Blob([files.get(p)!]), error: null } : { data: null, error: { message: "missing" } }) }) },
        schema: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "org_export_manifest") return { data: m, error: null };
          return recordFails ? { data: null, error: { message: "boom", code: "XX000" } } : { data: null, error: null };
        } }),
      } as never,
    };
  };
  const ok = make(false);
  const result = await lib.verifyStoredOrganizationExport(ok.client, "j");
  assert.equal(result.ok, true);
  assert.equal(result.recorded, true);
  assert.deepEqual(ok.calls.find((call) => call.name === "org_export_record_verification")?.args, { p_job: "j", p_ok: true, p_failure_count: 0 });
  const broken = make(true);
  const again = await lib.verifyStoredOrganizationExport(broken.client, "j");
  assert.deepEqual([again.ok, again.recorded], [true, false]);
  files.set(chunk.path, '{"id":"a","organization_id":"x"}\n');
  const tampered = make(false);
  const bad = await lib.verifyStoredOrganizationExport(tampered.client, "j");
  assert.equal(bad.ok, false);
  const recorded = tampered.calls.find((call) => call.name === "org_export_record_verification")!.args;
  assert.equal(recorded.p_ok, false);
  assert.ok(Number(recorded.p_failure_count) >= 1);
});

test("wiring: scope, purge and verification are owner-only RPCs; the storage page degrades instead of showing zero", () => {
  const sql = read("supabase/migrations/20261031130000_export_scope_retention.sql");
  assert.match(sql, /create policy organization_exports_delete on storage\.objects for delete/);
  assert.match(sql, /app\.is_business_owner_member\(app\.fn_active_organization\(\)\)/);
  const page = read("apps/web/src/app/settings/storage/page.tsx");
  assert.match(page, /exports\.authorized \? await Promise\.all/);
  assert.match(page, /ExportScopePanel/);
  const actions = read("apps/web/src/app/settings/storage/export-actions.ts");
  assert.match(actions, /export async function purgeOrganizationExportAction/);
  assert.doesNotMatch(actions, /organization_id|organizationId|p_org\b/);
  const restore = read("apps/web/scripts/verify-org-export.ts");
  assert.match(restore, /DRY RUN ONLY/);
});
