import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chunkPath, ORG_EXPORT_FORMAT, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, type ExportManifest } from "../src/lib/org-export-manifest";
import { PROBE_FORMAT, planRestoreReadiness, type TargetSchema, type TargetTable } from "../src/lib/org-export-restore-plan";
import { runCli } from "../scripts/verify-org-export";

const ORG = "11111111-1111-4111-8111-111111111111";
const PREFIX = `${ORG}/exports/22222222-2222-4222-8222-222222222222`;
const lines = (rows: Array<Record<string, unknown>>) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Tables = Record<string, Array<Record<string, unknown>>>;
const DEFAULT_TABLES: Tables = {
  branches: [{ id: id(1), organization_id: ORG, name: "Main" }],
  customers: [{ id: id(10), organization_id: ORG, display_name: "Ani", portal_user_id: id(900) }, { id: id(11), organization_id: ORG, display_name: "Budi", portal_user_id: null }],
  cash_accounts: [{ id: id(20), organization_id: ORG, branch_id: id(1), name: "Kas", currency: "IDR" }],
  cash_movements: [
    { id: id(30), organization_id: ORG, account_id: id(20), amount: "100.00", reversal_of: null },
    { id: id(31), organization_id: ORG, account_id: id(20), amount: "100.00", reversal_of: id(30) },
  ],
};

function archive(tables: Tables = DEFAULT_TABLES): { manifest: ExportManifest; files: Map<string, string> } {
  const files = new Map<string, string>();
  const config = JSON.stringify({ id: ORG, settings: {} });
  files.set(`${PREFIX}/configuration.json`, config);
  const exportTables = Object.entries(tables).map(([name, rows]) => {
    const text = lines(rows);
    const chunk = { index: 0, rowCount: rows.length, sha256: sha256(text), path: chunkPath(PREFIX, name, 0), firstId: String(rows[0].id), lastId: String(rows[rows.length - 1].id) };
    files.set(chunk.path, text);
    return { name, rowCount: rows.length, sha256: tableHash([chunk]), chunks: [chunk] };
  });
  const manifest: ExportManifest = {
    format: ORG_EXPORT_FORMAT, version: ORG_EXPORT_VERSION, generatedAt: "2026-10-12T00:00:00Z", organization: { id: ORG, slug: "org", name: "Org" },
    configuration: { path: `${PREFIX}/configuration.json`, sha256: sha256(config) }, tables: exportTables, storage: null, excluded: [], manifestSha256: null,
  };
  manifest.manifestSha256 = sha256(stableJson({ ...manifest, manifestSha256: null }));
  return { manifest, files };
}

const table = (columns: string[], extra: Partial<TargetTable> = {}): TargetTable => ({ columns, required: ["organization_id"], foreignKeys: [], insertOnly: false, existingRows: 0, ...extra });
function schema(extra: Partial<Record<string, Partial<TargetTable>>> = {}, org = ORG): TargetSchema {
  const base: Record<string, TargetTable> = {
    branches: table(["id", "organization_id", "name"]),
    customers: table(["id", "organization_id", "display_name", "portal_user_id"], { foreignKeys: [{ columns: ["organization_id"], refTable: "organizations", refColumns: ["id"] }, { columns: ["portal_user_id"], refTable: "users", refColumns: ["id"] }] }),
    cash_accounts: table(["id", "organization_id", "branch_id", "name", "currency"], { foreignKeys: [{ columns: ["organization_id", "branch_id"], refTable: "branches", refColumns: ["organization_id", "id"] }] }),
    cash_movements: table(["id", "organization_id", "account_id", "amount", "reversal_of"], {
      insertOnly: true,
      foreignKeys: [
        { columns: ["organization_id", "account_id"], refTable: "cash_accounts", refColumns: ["organization_id", "id"] },
        { columns: ["organization_id", "reversal_of"], refTable: "cash_movements", refColumns: ["organization_id", "id"] },
      ],
    }),
  };
  for (const [name, patch] of Object.entries(extra)) base[name] = { ...(base[name] ?? table([])), ...patch } as TargetTable;
  return { format: PROBE_FORMAT, version: 1, schemaVersion: "20261031130000", organizationId: org, tables: base };
}
const plan = (a = archive(), s: unknown = schema()) => planRestoreReadiness(a.manifest, (p) => a.files.get(p) ?? null, s);

test("a consistent archive against a compatible empty target passes, with a dependency-safe INSERT-only order", () => {
  const result = plan();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.order.map((step) => step.table), ["branches", "customers", "cash_accounts", "cash_movements"]);
  assert.deepEqual(result.order.map((step) => step.mode), ["insert", "insert", "insert", "insert_only"], "the table with an immutability trigger is marked insert-only");
  assert.deepEqual(result.summary, { tables: 4, rows: 6, insertOnlyTables: 1 });
  assert.ok(result.warnings.some((warning) => /not_in_archive:storage_object_bodies,auth_identities,provider_credentials/.test(warning)), "a pass never claims bodies, identities or secrets are present");
  assert.ok(result.warnings.some((warning) => /load_with_triggers_bypassed:1/.test(warning)));
  assert.deepEqual(result.externalReferences, [{ table: "customers", columns: ["portal_user_id"], refTable: "users", distinctValues: 1 }], "a reference to an identity outside the archive is reported, not guessed");
  assert.equal(result.cycles.length, 0);
});

test("order follows foreign keys even when the manifest lists children first", () => {
  const reordered = archive({ cash_movements: DEFAULT_TABLES.cash_movements, cash_accounts: DEFAULT_TABLES.cash_accounts, branches: DEFAULT_TABLES.branches });
  const result = plan(reordered);
  assert.deepEqual(result.order.map((step) => step.table), ["branches", "cash_accounts", "cash_movements"]);
});

test("unsafe, unknown and over-wide input is rejected", () => {
  const withRoles = archive({ ...DEFAULT_TABLES, roles: [{ id: id(40), organization_id: ORG, name: "Owner" }] });
  assert.ok(plan(withRoles, schema({ roles: { columns: ["id", "organization_id", "name"] } })).failures.includes("unsafe_table:roles"), "identity/access tables are never loadable, even if the target has them");
  const unknownTable = archive({ ...DEFAULT_TABLES, brand_new_table: [{ id: id(41), organization_id: ORG }] });
  assert.ok(plan(unknownTable).failures.includes("unknown_table:brand_new_table"));
  const widerRow = archive({ ...DEFAULT_TABLES, branches: [{ id: id(1), organization_id: ORG, name: "Main", future_column: 1 }] });
  assert.ok(plan(widerRow).failures.includes("unknown_column:branches.future_column"), "an archive from a newer schema is not loadable into an older one");
  const secret = archive({ ...DEFAULT_TABLES, branches: [{ id: id(1), organization_id: ORG, name: "Main", api_key: "k" }] });
  const secretResult = plan(secret, schema({ branches: { columns: ["id", "organization_id", "name", "api_key"] } }));
  assert.ok(secretResult.failures.includes("forbidden_column:branches.api_key"));
  assert.ok(secretResult.failures.some((failure) => failure.startsWith("archive:forbidden_key")), "the archive verifier flags it as well");
  const missing = archive({ ...DEFAULT_TABLES, branches: [{ id: id(1), name: "Main", organization_id: ORG }] });
  assert.ok(plan(missing, schema({ branches: { required: ["organization_id", "timezone"] } })).failures.includes("missing_required_column:branches.timezone"));
});

test("foreign keys inside the archive must be satisfied by the archive; self references and composites work", () => {
  const dangling = archive({ ...DEFAULT_TABLES, cash_movements: [{ id: id(30), organization_id: ORG, account_id: id(999), amount: "1", reversal_of: null }] });
  assert.ok(plan(dangling).failures.includes("fk_dangling:cash_movements(organization_id,account_id)->cash_accounts:1"));
  const badReversal = archive({ ...DEFAULT_TABLES, cash_movements: [{ id: id(31), organization_id: ORG, account_id: id(20), amount: "1", reversal_of: id(777) }] });
  assert.ok(plan(badReversal).failures.includes("fk_dangling:cash_movements(organization_id,reversal_of)->cash_movements:1"));
  assert.equal(plan().failures.length, 0, "the valid self-reference (reversal_of) passes");
});

test("the target must be empty for this organization and must describe the same organization", () => {
  const dirty = plan(archive(), schema({ customers: { existingRows: 3 } }));
  assert.ok(dirty.failures.includes("target_not_empty:customers:3"));
  const other = plan(archive(), schema({}, id(555)));
  assert.ok(other.failures.includes("schema_probe_organization_mismatch"));
  for (const bad of [null, {}, { format: PROBE_FORMAT, version: 2, organizationId: ORG, tables: {} }, "text", { format: "x" }]) {
    const result = plan(archive(), bad);
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes("schema_probe_invalid"));
  }
});

test("a tampered or missing archive file fails the plan through the archive verifier", () => {
  const tampered = archive();
  tampered.files.set(tampered.manifest.tables[0].chunks[0].path, lines([{ id: id(1), organization_id: ORG, name: "Hacked" }]));
  const result = plan(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.startsWith("archive:chunk_hash_mismatch")));
  const missing = archive();
  missing.files.delete(missing.manifest.tables[1].chunks[0].path);
  assert.ok(plan(missing).failures.some((failure) => failure.startsWith("archive:chunk_missing")));
  assert.equal(planRestoreReadiness(null, () => null, schema()).ok, false);
  assert.equal(planRestoreReadiness({}, () => null, schema()).ok, false);
});

test("a foreign-key cycle is reported instead of looping, and its tables stay in the plan, flagged as having no safe order", () => {
  const cyclic = archive({
    a: [{ id: id(1), organization_id: ORG, b_id: id(2) }],
    b: [{ id: id(2), organization_id: ORG, a_id: id(1) }],
  });
  const result = plan(cyclic, schema({
    a: { columns: ["id", "organization_id", "b_id"], foreignKeys: [{ columns: ["b_id"], refTable: "b", refColumns: ["id"] }] },
    b: { columns: ["id", "organization_id", "a_id"], foreignKeys: [{ columns: ["a_id"], refTable: "a", refColumns: ["id"] }] },
    branches: {}, customers: {}, cash_accounts: {}, cash_movements: {},
  }));
  assert.deepEqual(result.cycles, [["a", "b"]]);
  assert.deepEqual(result.order.map((step) => [step.table, step.cyclic === true]), [["a", true], ["b", true]], "cyclic tables are appended and flagged, never dropped");
  assert.equal(result.summary.tables, 2);
  assert.ok(result.warnings.some((warning) => /^fk_cycle:2 tables \(a,b\).*session_replication_role = replica.*validate every foreign key/.test(warning)));
});

test("the plan is pure: it takes callbacks and data, and the module names no network or database client", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/lib/org-export-restore-plan.ts"), "utf8");
  const cli = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/verify-org-export.ts"), "utf8");
  assert.doesNotMatch(source + cli, /from "pg"|postgres|createClient|fetch\(|supabase|process\.env|net\.connect|http/i);
  assert.doesNotMatch(cli, /writeFile|appendFile|unlink|rmSync|mkdirSync|execSync|spawn/);
});

function writeArchive(dir: string, layout: "bucket" | "job", a = archive(), probe: unknown = schema()): string {
  for (const [relative, text] of a.files) {
    const target = path.join(dir, layout === "bucket" ? relative : relative.split("/").slice(3).join("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const manifestTarget = path.join(dir, layout === "bucket" ? `${PREFIX}/manifest.json` : "manifest.json");
  fs.mkdirSync(path.dirname(manifestTarget), { recursive: true });
  fs.writeFileSync(manifestTarget, stableJson(a.manifest));
  const probePath = path.join(os.tmpdir(), `probe-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(probePath, JSON.stringify(probe));
  return probePath;
}

test("CLI: passes on a bucket-layout and a job-folder-only extraction, fails with exit 1 on a defect, exit 2 on bad usage", () => {
  for (const layout of ["bucket", "job"] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cli-"));
    const probe = writeArchive(dir, layout);
    const ok = runCli([dir, probe]);
    assert.equal(ok.code, 0, `${layout}: ${ok.output}`);
    assert.match(ok.output, /PASS \(this is not a restore and not a recovery claim\)/);
    assert.match(ok.output, /1\. branches/);
    const json = runCli([dir, probe, "--json"]);
    assert.equal(JSON.parse(json.output).ok, true);
    const dirty = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cli-"));
    const dirtyProbe = writeArchive(dirty, layout, archive(), schema({ customers: { existingRows: 2 } }));
    const bad = runCli([dirty, dirtyProbe]);
    assert.equal(bad.code, 1);
    assert.match(bad.output, /FAIL target_not_empty:customers:2/);
  }
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli(["/definitely/not/here", "/x"]).code, 2);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cli-"));
  assert.equal(runCli([empty, path.join(empty, "probe.json")]).code, 2, "no manifest");
});

test("CLI: a manifest that names a path outside the archive is refused and nothing outside is read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cli-"));
  const secretFile = path.join(os.tmpdir(), `outside-${process.pid}.jsonl`);
  fs.writeFileSync(secretFile, lines([{ id: id(1), organization_id: ORG }]));
  const a = archive();
  const chunk = a.manifest.tables[0].chunks[0];
  chunk.path = `${PREFIX}/tables/branches/../../../../../../${path.relative(path.parse(os.tmpdir()).root, secretFile).replace(/\\/g, "/")}`;
  a.manifest.manifestSha256 = sha256(stableJson({ ...a.manifest, manifestSha256: null }));
  const probe = writeArchive(dir, "bucket", a);
  const result = runCli([dir, probe]);
  assert.equal(result.code, 1);
  assert.ok(result.plan?.failures.some((failure) => failure.startsWith("archive:chunk_path_invalid") || failure.startsWith("archive:chunk_missing")));
});
