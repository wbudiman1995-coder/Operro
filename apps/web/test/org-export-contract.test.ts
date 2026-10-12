import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chunkPath, ORG_EXPORT_FORMAT, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, sanitizeTabularCell, type ExportManifest } from "../src/lib/org-export-manifest";
import { verifyOrganizationExport } from "../src/lib/org-export-verify";

const root = path.resolve(import.meta.dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261028100000_org_export_foundation.sql"), "utf8").replace(/\r\n/g, "\n");
const scopeMigration = fs.readFileSync(path.join(root, "supabase/migrations/20261031130000_export_scope_retention.sql"), "utf8").replace(/\r\n/g, "\n");
const exportLib = fs.readFileSync(path.join(root, "apps/web/src/lib/org-export.ts"), "utf8");
const exportActions = fs.readFileSync(path.join(root, "apps/web/src/app/settings/storage/export-actions.ts"), "utf8");

const PREFIX = "org/exports/job";
const lines = (rows: Array<Record<string, unknown>>) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
function seal(manifest: ExportManifest) { manifest.manifestSha256 = sha256(stableJson({ ...manifest, manifestSha256: null })); }

function fixture(): { manifest: ExportManifest; files: Map<string, string> } {
  const rows = lines([{ id: "a", organization_id: "org" }, { id: "b", organization_id: "org" }]);
  const config = JSON.stringify({ id: "org", settings: { documents: {} } });
  const listing = JSON.stringify({ included: true, truncated: false, objects: [{ bucket: "attachments", name: "org/photo.jpg", size: 1, mimetype: "image/jpeg" }] });
  const chunk = { index: 0, rowCount: 2, sha256: sha256(rows), path: chunkPath(PREFIX, "customers", 0), firstId: "a", lastId: "b" };
  const manifest: ExportManifest = {
    format: ORG_EXPORT_FORMAT, version: ORG_EXPORT_VERSION, generatedAt: "2026-10-28T00:00:00Z", organization: { id: "org", slug: "org", name: "Org" },
    configuration: { path: `${PREFIX}/configuration.json`, sha256: sha256(config) },
    tables: [{ name: "customers", rowCount: 2, sha256: tableHash([chunk]), chunks: [chunk] }],
    storage: { path: `${PREFIX}/storage-listing.json`, sha256: sha256(listing), objectCount: 1, truncated: false }, excluded: [], manifestSha256: null,
  };
  seal(manifest);
  return { manifest, files: new Map([[chunk.path, rows], [manifest.configuration.path, config], [manifest.storage!.path, listing]]) };
}
const failures = (manifest: ExportManifest, files: Map<string, string>) => verifyOrganizationExport(manifest, (p) => files.get(p) ?? null).failures;
/** Rewrite the chunk and re-seal every hash so only the intended defect is reported. */
function reseal(manifest: ExportManifest, files: Map<string, string>, chunkText: string) {
  const chunk = manifest.tables[0].chunks[0]; files.set(chunk.path, chunkText); chunk.sha256 = sha256(chunkText);
  manifest.tables[0].sha256 = tableHash([chunk]); seal(manifest);
}

test("verifies a complete archive", () => { const { manifest, files } = fixture(); const result = verifyOrganizationExport(manifest, (p) => files.get(p) ?? null); assert.deepEqual(result.failures, []); assert.equal(result.ok, true); });
test("rejects a missing chunk", () => { const { manifest, files } = fixture(); files.delete(manifest.tables[0].chunks[0].path); assert.ok(failures(manifest, files).some((f) => f.startsWith("chunk_missing"))); });
test("rejects a tampered chunk (hash)", () => { const { manifest, files } = fixture(); files.set(manifest.tables[0].chunks[0].path, lines([{ id: "a", organization_id: "org", x: 1 }])); assert.ok(failures(manifest, files).some((f) => f.startsWith("chunk_hash_mismatch"))); });
test("rejects tenant mismatch", () => {
  const { manifest, files } = fixture();
  reseal(manifest, files, lines([{ id: "a", organization_id: "org" }, { id: "b", organization_id: "other" }]));
  assert.deepEqual(failures(manifest, files), ["tenant_mismatch:" + manifest.tables[0].chunks[0].path]);
});
test("rejects out-of-order rows, a wrong id range and a non-deterministic path", () => {
  const a = fixture(); reseal(a.manifest, a.files, lines([{ id: "b", organization_id: "org" }, { id: "a", organization_id: "org" }]));
  assert.ok(failures(a.manifest, a.files).some((f) => f.startsWith("row_order_invalid")));
  assert.ok(failures(a.manifest, a.files).some((f) => f.startsWith("chunk_id_range_mismatch")));
  const b = fixture(); b.manifest.tables[0].chunks[0].path = `${PREFIX}/tables/customers/other.jsonl`; b.files.set(b.manifest.tables[0].chunks[0].path, "x");
  assert.ok(failures(b.manifest, b.files).some((f) => f.startsWith("chunk_path_invalid")));
});
test("rejects forbidden credential-like keys in rows, configuration and storage listing", () => {
  const a = fixture(); reseal(a.manifest, a.files, lines([{ id: "a", organization_id: "org", token_hash: "x" }, { id: "b", organization_id: "org" }]));
  assert.ok(failures(a.manifest, a.files).some((f) => f.startsWith("forbidden_key")));
  const b = fixture(); const config = JSON.stringify({ id: "org", settings: { platform_billing: {} } });
  b.files.set(b.manifest.configuration.path, config); b.manifest.configuration.sha256 = sha256(config); seal(b.manifest);
  assert.ok(failures(b.manifest, b.files).includes("configuration_forbidden_key"));
  const c = fixture(); const listing = JSON.stringify({ included: true, truncated: false, objects: [{ bucket: "attachments", name: "org/photo.jpg", signedUrl: "https://x" }] });
  c.files.set(c.manifest.storage!.path, listing); c.manifest.storage!.sha256 = sha256(listing); seal(c.manifest);
  assert.ok(failures(c.manifest, c.files).includes("storage_listing_forbidden_key"));
});
test("rejects another organization's storage object", () => {
  const { manifest, files } = fixture(); const listing = JSON.stringify({ included: true, truncated: false, objects: [{ bucket: "attachments", name: "other/photo.jpg" }] });
  files.set(manifest.storage!.path, listing); manifest.storage!.sha256 = sha256(listing); seal(manifest);
  assert.ok(failures(manifest, files).some((f) => f.startsWith("storage_listing_tenant_mismatch")));
});
test("rejects a manifest edited after sealing and an archive path outside the organization prefix", () => {
  const a = fixture(); a.manifest.organization.name = "Edited"; assert.ok(failures(a.manifest, a.files).includes("manifest_hash_mismatch"));
  const b = fixture(); b.manifest.configuration.path = "other/exports/job/configuration.json"; assert.ok(failures(b.manifest, b.files).includes("archive_prefix_invalid"));
});
test("manifest hashing is deterministic regardless of key order or locale", () => {
  assert.equal(stableJson({ b: 1, a: { d: 1, C: 2 } }), stableJson({ a: { C: 2, d: 1 }, b: 1 }));
  assert.equal(stableJson({ a: 1, B: 2 }), '{"B":2,"a":1}');
});
test("escapes formula-leading tabular cells", () => { assert.equal(sanitizeTabularCell("=1+1"), "'=1+1"); assert.equal(sanitizeTabularCell("normal"), "normal"); });

test("export migration: every definer has an empty search_path, no client role keeps default execute, and no secret-bearing table is listed", () => {
  const definers = migration.match(/create function app\.[a-z_]+\([^)]*\)[^$]*?security definer[^$]*?\$\$/g) ?? [];
  assert.ok(definers.length >= 12, `found ${definers.length}`);
  for (const definer of definers) assert.match(definer, /set search_path = ''/, definer.slice(0, 60));
  assert.equal((migration.match(/security definer/g) ?? []).length, definers.length);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated;/);
  assert.match(migration, /revoke all on app\.organization_export_table_specs from public, anon, authenticated/);
  const allowlist = migration.slice(migration.indexOf("insert into app.organization_export_table_specs"), migration.indexOf("create table public.organization_export_table_state"));
  for (const table of ["customer_onboarding_links", "platform_access_invitations", "memberships", "roles", "organization_bank_accounts", "subscriptions", "platform_billing_periods", "platform_invoices"]) assert.doesNotMatch(allowlist, new RegExp(`'${table}'`), table);
  assert.match(migration, /organization_export_jobs_one_running_idx/);
});
test("export web layer: organization comes from the session, uploads are idempotent, finalize re-verifies", () => {
  assert.doesNotMatch(exportActions, /organization_?id|activeOrganization/i);
  assert.match(exportActions, /JOB_ID\.test\(jobId\)/);
  assert.match(exportLib, /upsert: true/);
  assert.match(exportLib, /verifyOrganizationExport\(manifest/);
  assert.match(exportLib, /DOWNLOAD_BATCH/);
  assert.doesNotMatch(exportLib + exportActions, /createSignedUrl|getPublicUrl|service_role|SERVICE_ROLE/);
});

test("every RPC the web layer calls exists in the migration with exactly those parameter names", () => {
  const defined = new Map<string, string[]>();
  for (const match of [migration, scopeMigration].join("\n").matchAll(/create function app\.(org_export_[a-z_]+)\(([^)]*)\)/g)) defined.set(match[1], [...match[2].matchAll(/(p_[a-z_]+)\s/g)].map((param) => param[1]).sort());
  const calls = [...exportLib.matchAll(/rpc(?:<[^()]*?>)?\(supabase, "(org_export_[a-z_]+)", \{([^}]*)\}\)/g)];
  assert.ok(calls.length >= 11, `found ${calls.length} rpc calls`);
  for (const [, name, args] of calls) {
    assert.ok(defined.has(name), `${name} is not defined by the migration`);
    const sent = [...args.matchAll(/(p_[a-z_]+):/g)].map((param) => param[1]).sort();
    // optional trailing parameters (defaults) may be omitted, but nothing unknown may be sent
    for (const param of sent) assert.ok(defined.get(name)!.includes(param), `${name} has no parameter ${param}`);
    assert.ok(sent.length >= defined.get(name)!.length - (name === "org_export_table_page" || name === "org_export_start" || name === "org_export_cancel" ? 1 : 0), `${name} omits required parameters: sent ${sent}, defined ${defined.get(name)}`);
  }
});

test("export completeness is enforced in SQL, not trusted from the client", () => {
  const finish = migration.slice(migration.indexOf("create function app.org_export_finish_table"), migration.indexOf("-- Workspace configuration."));
  assert.match(finish, /export_incomplete/);
  assert.match(finish, /id > \$2/);
  const record = migration.slice(migration.indexOf("create function app.org_export_record_chunk"), migration.indexOf("create function app.org_export_finish_table"));
  assert.match(record, /select count\(\*\), \(array_agg\(id order by id\)\)\[1\], \(array_agg\(id order by id desc\)\)\[1\] from \(select id from public\.%I/);
  assert.match(record, /v_page_first is distinct from p_first_id/);
});
