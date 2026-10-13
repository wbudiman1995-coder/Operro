import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runRestoreCli } from "../scripts/restore-org-export";
import { buildFixtureArchive } from "../scripts/build-fixture-archive";
import { chunkPath, ORG_EXPORT_FORMAT, ORG_EXPORT_VERSION, sha256, stableJson, tableHash, type ExportManifest } from "../src/lib/org-export-manifest";
import { generateRestoreSql, idsHash, RESTORE_REPORT_FORMAT } from "../src/lib/org-export-restore-sql";
import { PROBE_FORMAT, type TargetSchema, type TargetTable } from "../src/lib/org-export-restore-plan";

const root = path.resolve(import.meta.dirname, "../../..");
const ORG = "11111111-1111-4111-8111-111111111111";
const PREFIX = `${ORG}/exports/22222222-2222-4222-8222-222222222222`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lines = (rows: Array<Record<string, unknown>>) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

type Tables = Record<string, Array<Record<string, unknown>>>;
const DEFAULT_TABLES: Tables = {
  branches: [{ id: id(1), organization_id: ORG, name: "Main" }],
  customers: [{ id: id(10), organization_id: ORG, display_name: "Ani" }, { id: id(11), organization_id: ORG, display_name: "Budi" }],
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
    format: ORG_EXPORT_FORMAT, version: ORG_EXPORT_VERSION, generatedAt: "2026-10-13T00:00:00Z", organization: { id: ORG, slug: "org", name: "Org" },
    configuration: { path: `${PREFIX}/configuration.json`, sha256: sha256(config) }, tables: exportTables, storage: null, excluded: [], manifestSha256: null,
  };
  manifest.manifestSha256 = sha256(stableJson({ ...manifest, manifestSha256: null }));
  return { manifest, files };
}
const table = (columns: string[], extra: Partial<TargetTable> = {}): TargetTable => ({ columns, required: ["organization_id"], foreignKeys: [], insertOnly: false, existingRows: 0, ...extra });
function schema(extra: Partial<Record<string, Partial<TargetTable>>> = {}): TargetSchema {
  const base: Record<string, TargetTable> = {
    branches: table(["id", "organization_id", "name"]),
    customers: table(["id", "organization_id", "display_name"]),
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
  return { format: PROBE_FORMAT, version: 1, schemaVersion: "20261101130000", organizationId: ORG, tables: base };
}
const generate = (a = archive(), probe: unknown = schema(), targetDatabase = "restore_drill_1") =>
  generateRestoreSql({ manifest: a.manifest, read: (p) => a.files.get(p) ?? null, probe, targetDatabase, now: new Date("2026-10-13T00:00:00Z") });

test("a verified archive and a compatible empty target produce one guarded transaction and a report", () => {
  const result = generate();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { sql, report } = result;
  assert.equal(report.format, RESTORE_REPORT_FORMAT);
  assert.equal(report.organizationId, ORG);
  assert.equal(report.targetDatabase, "restore_drill_1");
  assert.equal(report.targetSchemaVersion, "20261101130000");
  assert.equal(report.totalRows, 6);
  assert.deepEqual(report.tables.map((entry) => [entry.name, entry.mode]), [["branches", "insert"], ["customers", "insert"], ["cash_accounts", "insert"], ["cash_movements", "insert_only"]]);
  assert.equal(report.sqlSha256, sha256(sql));
  assert.match(report.reportSha256, /^[0-9a-f]{64}$/);
  assert.match(report.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(generate().ok && (generate() as { sql: string }).sql, sql, "the script is deterministic for a fixed archive, probe and clock");
});

test("every guard is in the script, in the order that makes a failure harmless", () => {
  const result = generate();
  assert.ok(result.ok);
  if (!result.ok) return;
  const at = (needle: string | RegExp) => { const index = typeof needle === "string" ? result.sql.indexOf(needle) : result.sql.search(needle); assert.ok(index >= 0, `script contains ${String(needle)}`); return index; };
  const order = [
    at("\\set ON_ERROR_STOP on"), at("begin;"), at("current_database() <> 'restore_drill_1'"), at("to_regclass('public.operro_restore_target') is null"),
    at("restore_target_not_marked_disposable"), at("app.schema_version() <> '20261101130000'"), at("restore_organization_row_missing"),
    at("set local session_replication_role = replica;"), at("restore_target_not_empty"), at("select pg_temp.restore_load_chunk("),
    at("select pg_temp.restore_verify_table("), at("restore_immutability_trigger_missing"), at("RESTORE_RESULT"), result.sql.lastIndexOf("commit;"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "guards precede the first write; verification follows the load; commit is last");
  assert.match(result.sql, /restore_chunk_hash_mismatch/);
  assert.match(result.sql, /restore_foreign_organization_row/);
  assert.match(result.sql, /restore_row_mismatch/);
  assert.match(result.sql, /session_replication_role = replica/);
  assert.doesNotMatch(result.sql, /\b(drop|truncate|delete\s+from|alter\s+table|grant|revoke)\b/i, "the script never drops, truncates, deletes or changes privileges");
  assert.doesNotMatch(result.sql, /\bcreate\s+(table|extension|role|schema)\b/i, "and creates no permanent object (only temporary helper functions)");
  assert.equal((result.sql.match(/create function pg_temp\./g) ?? []).length, 2);
});

test("an archive that fails verification yields no script", () => {
  const broken = archive();
  const chunkFile = [...broken.files.keys()].find((file) => file.includes("/customers/"))!;
  broken.files.set(chunkFile, broken.files.get(chunkFile)!.replace("Ani", "Eve"));
  const result = generate(broken);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failures.some((failure) => failure.startsWith("archive:chunk_hash_mismatch")));
});

test("unknown tables, unsafe tables, credential-like columns and foreign tenants are refused", () => {
  const unknown = archive({ ...DEFAULT_TABLES, mystery: [{ id: id(40), organization_id: ORG }] });
  assert.ok(!generate(unknown).ok && (generate(unknown) as { failures: string[] }).failures.includes("unknown_table:mystery"));
  const unsafe = archive({ ...DEFAULT_TABLES, memberships: [{ id: id(41), organization_id: ORG }] });
  assert.ok((generate(unsafe, schema({ memberships: table(["id", "organization_id"]) })) as { failures: string[] }).failures.includes("unsafe_table:memberships"));
  const secret = archive({ ...DEFAULT_TABLES, customers: [{ id: id(10), organization_id: ORG, display_name: "Ani", api_key: "x" }] });
  const refused = generate(secret, schema({ customers: table(["id", "organization_id", "display_name", "api_key"]) }));
  assert.ok(!refused.ok && refused.failures.some((failure) => failure.startsWith("forbidden_column:customers.api_key") || failure.startsWith("archive:forbidden_key")));
  const foreign = archive({ ...DEFAULT_TABLES, customers: [{ id: id(10), organization_id: "99999999-9999-4999-8999-999999999999", display_name: "Ani" }] });
  assert.ok(!generate(foreign).ok);
});

test("a target that already holds rows, or whose probe belongs to another organization, is refused", () => {
  const dirty = generate(archive(), schema({ customers: { existingRows: 3 } }));
  assert.ok(!dirty.ok && dirty.failures.includes("target_not_empty:customers:3"));
  const other = schema();
  other.organizationId = "99999999-9999-4999-8999-999999999999";
  assert.ok(!generate(archive(), other).ok);
  const noVersion = schema();
  (noVersion as { schemaVersion: string }).schemaVersion = "unknown";
  const refused = generate(archive(), noVersion);
  assert.ok(!refused.ok && refused.failures.includes("probe_schema_version_unknown"));
  assert.ok(!generate(archive(), { format: "nope" }).ok);
});

test("a target database name must be stated, well formed and not production-looking", () => {
  for (const bad of ["", "bad name", "a;drop", "operro_prod", "prod", "production-db", "live", "main", "x".repeat(64)]) {
    const refused = generate(archive(), schema(), bad);
    assert.equal(refused.ok, false, `refused ${JSON.stringify(bad)}`);
  }
  for (const good of ["restore_drill_1", "disposable-2026", "scratch", "products_copy_is_fine".replace("products", "restore")]) assert.equal(generate(archive(), schema(), good).ok, true, good);
});

test("row text can never close the quoting around it", () => {
  const nasty = archive({
    branches: [{ id: id(1), organization_id: ORG, name: "$c$; drop table customers; --" }, { id: id(2), organization_id: ORG, name: "$c1$ and $c2$ and 'quotes' and \\backslash" }],
  });
  const result = generate(nasty, schema({ branches: table(["id", "organization_id", "name"]) }));
  assert.ok(result.ok);
  if (!result.ok) return;
  const load = result.sql.match(/select pg_temp\.restore_load_chunk\('branches', '[^']+'::uuid, (\$c\d*\$)/);
  assert.ok(load, "the chunk is dollar-quoted");
  assert.notEqual(load![1], "$c$", "a tag that occurs in the data is not used");
  const tag = load![1];
  const inside = result.sql.slice(result.sql.indexOf(tag) + tag.length, result.sql.indexOf(tag, result.sql.indexOf(tag) + tag.length));
  assert.ok(inside.includes("drop table customers"), "the dangerous text stays inside the literal");
  assert.equal(inside.includes(tag), false);
});

test("the id-list hash is order independent and matches plain code-unit order", () => {
  const ids = [id(3), id(1), id(2)];
  assert.equal(idsHash(ids), idsHash([id(1), id(2), id(3)]));
  assert.equal(idsHash(ids), sha256([id(1), id(2), id(3)].join("\n")));
  assert.equal(idsHash([]), sha256(""));
});

test("no migration creates the disposable marker, and no application code imports the restore generator", () => {
  for (const name of fs.readdirSync(path.join(root, "supabase/migrations"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8"), /operro_restore_target/, `${name} must not create the marker: only an operator declares a disposable target`);
  }
  const walk = (dir: string, found: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, found);
      else if (/\.(ts|tsx)$/.test(entry.name) && /org-export-restore-sql/.test(fs.readFileSync(full, "utf8")) && !full.endsWith("org-export-restore-sql.ts")) found.push(path.relative(root, full));
    }
    return found;
  };
  assert.deepEqual(walk(path.join(root, "apps/web/src")), [], "the restore generator is an offline tool only; no route or action can reach it");
  const lib = fs.readFileSync(path.join(root, "apps/web/src/lib/org-export-restore-sql.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(lib, /process\.env|\bfetch\s*\(|supabase|createClient|node:child_process|node:net|node:http/i, "the generator holds no connection, credential or network access");
});

test("the command line refuses bad usage, never overwrites, and writes nothing when generation is refused", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "operro-restore-cli-"));
  const dump = path.join(work, "dump");
  fs.mkdirSync(dump);
  const a = archive();
  const names = Object.keys(DEFAULT_TABLES);
  fs.writeFileSync(path.join(dump, "tables.txt"), names.join("\n"));
  for (const name of names) fs.writeFileSync(path.join(dump, `${name}.jsonl`), lines(DEFAULT_TABLES[name]));
  fs.writeFileSync(path.join(dump, "configuration.json"), JSON.stringify({ id: ORG, settings: {} }));
  const out = path.join(work, "archive");
  buildFixtureArchive(dump, out, ORG, "org", "Org");
  const probePath = path.join(work, "probe.json");
  fs.writeFileSync(probePath, JSON.stringify(schema()));
  assert.ok(a.manifest);

  assert.equal(runRestoreCli([]).code, 2);
  assert.equal(runRestoreCli(["restore", out, probePath]).code, 2);
  assert.equal(runRestoreCli(["sql", out, probePath]).code, 2, "the target database is mandatory");
  assert.equal(runRestoreCli(["sql", out, probePath, "--target-database", "restore_drill_1"]).code, 2, "so is the output file");
  assert.equal(runRestoreCli(["sql", out, probePath, "--target-database", "restore_drill_1", "--out", path.join(work, "a.sql"), "--force"]).code, 2, "unknown options are refused");
  assert.equal(runRestoreCli(["sql", path.join(work, "missing"), probePath, "--target-database", "restore_drill_1", "--out", path.join(work, "a.sql")]).code, 2);

  const sqlPath = path.join(work, "restore.sql");
  const ok = runRestoreCli(["sql", out, probePath, "--target-database", "restore_drill_1", "--out", sqlPath]);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /not executed/);
  assert.match(ok.output, /not a restore and not a recovery claim/);
  assert.equal(fs.existsSync(sqlPath), true);
  assert.equal(JSON.parse(fs.readFileSync(`${sqlPath}.report.json`, "utf8")).organizationId, ORG);
  assert.equal(runRestoreCli(["sql", out, probePath, "--target-database", "restore_drill_1", "--out", sqlPath]).code, 2, "an existing output is never overwritten");

  const dirtyProbe = path.join(work, "dirty-probe.json");
  fs.writeFileSync(dirtyProbe, JSON.stringify(schema({ customers: { existingRows: 1 } })));
  const refusedPath = path.join(work, "refused.sql");
  const refused = runRestoreCli(["sql", out, dirtyProbe, "--target-database", "restore_drill_1", "--out", refusedPath]);
  assert.equal(refused.code, 1);
  assert.match(refused.output, /nothing was written/);
  assert.match(refused.output, /target_not_empty:customers:1/);
  assert.equal(fs.existsSync(refusedPath) || fs.existsSync(`${refusedPath}.report.json`), false);
});
