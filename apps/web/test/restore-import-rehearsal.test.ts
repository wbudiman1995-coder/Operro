/**
 * Restore-import rehearsal against a REAL PostgreSQL database (a disposable docker container; never a hosted project).
 *
 * It builds an archive in the exporter's exact format from synthetic source data, generates the guarded restore script, runs it on
 * disposable databases and proves what the script is supposed to guarantee: an exact, verified, tenant-contained, immutable-history-safe
 * load, and a refusal (with nothing written) for every unsafe target. It is skipped unless RESTORE_REHEARSAL_PSQL is set, because it needs
 * a database:
 *
 *   RESTORE_REHEARSAL_PSQL='["docker","exec","-i","<container>","psql","-U","postgres"]'   (a JSON array: the command that runs psql)
 *   RESTORE_REHEARSAL_TEMPLATE=<name of a database with every migration applied, used as a template>
 *
 * run_all_gates.sh GATE 9 sets both against its PostgreSQL 16 server. Nothing here touches a hosted project or credentials.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFixtureArchive } from "../scripts/build-fixture-archive";
import { runRestoreCli } from "../scripts/restore-org-export";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const command = (() => { try { return process.env.RESTORE_REHEARSAL_PSQL ? (JSON.parse(process.env.RESTORE_REHEARSAL_PSQL) as string[]) : null; } catch { return null; } })();
const template = process.env.RESTORE_REHEARSAL_TEMPLATE ?? "";
const skip = !command || !/^[a-z0-9_]+$/.test(template) ? "set RESTORE_REHEARSAL_PSQL and RESTORE_REHEARSAL_TEMPLATE (see run_all_gates.sh GATE 9)" : false;

const ORG = "f1000000-0000-4000-8000-000000000001";
const NEIGHBOUR = "f1000000-0000-4000-8000-000000000002";
const suffix = Date.now().toString(36);
const created: string[] = [];

function psql(db: string, sql: string, extra: string[] = []): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command![0], [...command!.slice(1), "-d", db, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...extra, "-f", "-"], { input: sql, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function cloneDatabase(label: string): string {
  const name = `restore_${label}_${suffix}`;
  const made = psql("postgres", `create database ${name} template ${template};`);
  assert.equal(made.status, 0, made.stderr);
  created.push(name);
  return name;
}
// The organization row is created with triggers bypassed: creating a workspace normally seeds default size bands (and similar), and a restore
// target must hold nothing for the organization except the row itself. The runbook gives the operator the same statement.
const ORG_ROW = `set session_replication_role = replica; insert into public.organizations (id, name, slug, status) values ('${ORG}', 'Restore Source', 'restore-source', 'active'); reset session_replication_role;`;
const MARKER = "create table public.operro_restore_target (kind text primary key check (kind = 'disposable'), declared_at timestamptz not null default now()); insert into public.operro_restore_target (kind) values ('disposable');";
function target(label: string, opts: { org?: boolean; marker?: boolean } = {}): string {
  const name = cloneDatabase(label);
  const sql = `${opts.org === false ? "" : ORG_ROW}\n${opts.marker === false ? "" : MARKER}`;
  const prepared = psql(name, sql);
  assert.equal(prepared.status, 0, prepared.stderr);
  return name;
}
const count = (db: string, table: string, org = ORG): number => Number(psql(db, `select count(*) from public.${table} where organization_id = '${org}';`).stdout.trim());
/** Row count and a content hash for every listed table in ONE round trip (each psql call through docker costs a few hundred milliseconds). */
function fingerprints(db: string, tables: readonly string[], org = ORG): Record<string, string> {
  const query = tables.map((table) => `select '${table}' || '=' || count(*) || ':' || md5(coalesce(string_agg(to_jsonb(t)::text, '' order by id), '')) from public.${table} t where organization_id = '${org}'`).join(" union all ");
  const out = psql(db, `${query};`);
  assert.equal(out.status, 0, out.stderr);
  return Object.fromEntries(out.stdout.trim().split("\n").map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
}

test.after(() => { if (command) for (const name of created) psql("postgres", `drop database if exists ${name} with (force);`); });

test("a guarded restore script reproduces the archive exactly, refuses every unsafe target and keeps history immutable", { skip }, async (t) => {
  // ---- source: synthetic data, then an archive in the exporter's exact format ----------------------------------------------------
  const source = cloneDatabase("src");
  const seeded = psql(source, fs.readFileSync(path.join(repoRoot, "integration/restore_import_fixture.sql"), "utf8"));
  assert.equal(seeded.status, 0, seeded.stderr);
  const specs = psql(source, "select table_name from app.organization_export_table_specs order by sort_order;").stdout.trim().split("\n").filter(Boolean);
  assert.ok(specs.includes("cash_movements") && specs.includes("marketing_spend_entries") && specs.includes("cash_account_mappings"), "the new streams' tables are in the archive scope");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "operro-restore-"));
  const dump = path.join(work, "dump");
  fs.mkdirSync(dump);
  fs.writeFileSync(path.join(dump, "tables.txt"), `${specs.join("\n")}\n`);
  let sourceRows = 0;
  for (const table of specs) {
    const rows = psql(source, `select to_jsonb(t)::text from public.${table} t where organization_id = '${ORG}' order by id;`);
    assert.equal(rows.status, 0, `${table}: ${rows.stderr}`);
    fs.writeFileSync(path.join(dump, `${table}.jsonl`), rows.stdout);
    sourceRows += rows.stdout.split("\n").filter(Boolean).length;
  }
  fs.writeFileSync(path.join(dump, "configuration.json"), JSON.stringify({ id: ORG, slug: "restore-source", name: "Restore Source", settings: {} }));
  const archive = path.join(work, "archive");
  buildFixtureArchive(dump, archive, ORG, "restore-source", "Restore Source");
  assert.ok(sourceRows > 450, "the archive holds the 450 customers and the other rows");

  // ---- the disposable target, described by the read-only schema probe --------------------------------------------------------------
  const tgt = target("tgt");
  const probeSql = fs.readFileSync(path.join(repoRoot, "docs/runbooks/restore-schema-probe.sql"), "utf8");
  const probe = psql(tgt, probeSql, ["-v", `org=${ORG}`]);
  assert.equal(probe.status, 0, probe.stderr);
  const probePath = path.join(work, "probe.json");
  fs.writeFileSync(probePath, probe.stdout.trim());

  await t.test("generation refuses a production-looking name and a missing argument, and writes nothing", () => {
    const refused = runRestoreCli(["sql", archive, probePath, "--target-database", "operro_prod", "--out", path.join(work, "never.sql")]);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /target_database_looks_like_production/);
    assert.equal(fs.existsSync(path.join(work, "never.sql")), false);
    assert.equal(runRestoreCli(["sql", archive, probePath, "--out", path.join(work, "never.sql")]).code, 2);
  });

  const sqlPath = path.join(work, "restore.sql");
  const generated = runRestoreCli(["sql", archive, probePath, "--target-database", tgt, "--out", sqlPath]);
  assert.equal(generated.code, 0, generated.output);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const report = JSON.parse(fs.readFileSync(`${sqlPath}.report.json`, "utf8")) as { totalRows: number; tables: Array<{ name: string; rows: number; mode: string }>; manifestSha256: string; sqlSha256: string };
  assert.equal(report.totalRows, sourceRows);
  assert.ok(report.tables.some((table) => table.name === "cash_movements" && table.mode === "insert_only"), "append-only tables are loaded INSERT-only");

  await t.test("the generated script does not overwrite an existing file", () => {
    assert.equal(runRestoreCli(["sql", archive, probePath, "--target-database", tgt, "--out", sqlPath]).code, 2);
  });

  await t.test("a target that is not marked disposable is refused and nothing is written", () => {
    const unmarked = target("nomarker", { marker: false });
    const result = psql(unmarked, sql.replace(`current_database() <> '${tgt}'`, `current_database() <> '${unmarked}'`).replace(`'${tgt}', current_database()`, `'${unmarked}', current_database()`));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restore_target_marker_missing/);
    assert.equal(count(unmarked, "customers"), 0);
  });

  await t.test("a marker with no 'disposable' row is refused", () => {
    const empty = target("emptymarker", { marker: false });
    assert.equal(psql(empty, "create table public.operro_restore_target (kind text primary key check (kind = 'disposable'));").status, 0);
    const result = psql(empty, sql.replace(`current_database() <> '${tgt}'`, `current_database() <> '${empty}'`));
    assert.match(result.stderr, /restore_target_not_marked_disposable/);
    assert.equal(count(empty, "customers"), 0);
  });

  await t.test("the script refuses to run in a database other than the one named at generation", () => {
    const other = target("other");
    const result = psql(other, sql);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restore_wrong_database/);
    assert.equal(count(other, "customers"), 0);
  });

  await t.test("a target without the organization row, or at another schema version, is refused", () => {
    const noOrg = target("noorg", { org: false });
    assert.match(psql(noOrg, sql.replace(`current_database() <> '${tgt}'`, `current_database() <> '${noOrg}'`)).stderr, /restore_organization_row_missing/);
    const drifted = target("drift");
    assert.equal(psql(drifted, "create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$ select '20200101000000'::text $$;").status, 0);
    assert.match(psql(drifted, sql.replace(`current_database() <> '${tgt}'`, `current_database() <> '${drifted}'`)).stderr, /restore_schema_version_mismatch/);
  });

  await t.test("a target that already holds this organization's rows is refused", () => {
    const dirty = target("dirty");
    assert.equal(psql(dirty, `insert into public.customers (id, organization_id, display_name, status) values ('f1000000-0000-4000-8000-0000000eeee1', '${ORG}', 'Already here', 'active');`).status, 0);
    const result = psql(dirty, sql.replace(`current_database() <> '${tgt}'`, `current_database() <> '${dirty}'`));
    assert.match(result.stderr, /restore_target_not_empty:customers/);
    assert.equal(count(dirty, "customers"), 1, "the existing row is untouched and nothing else was loaded");
    assert.equal(count(dirty, "payments"), 0);
  });

  await t.test("a tampered chunk is caught by its hash, and a late failure rolls the whole transaction back", () => {
    const tampered = target("tamper");
    const early = psql(tampered, sql.replace(`current_database() <> '${tgt}'`, `current_database() <> '${tampered}'`).replace("Pelanggan 1\"", "Pelanggan X\""));
    assert.match(early.stderr, /restore_chunk_hash_mismatch:customers/);
    // break the LAST chunk's hash: every earlier table has already been inserted inside the transaction when it fails
    const matches = [...sql.matchAll(/(\$c\d*\$), '([0-9a-f]{64})', (\d+)\);/g)];
    const last = matches[matches.length - 1];
    assert.ok(last && last.index !== undefined, "the script ends its loads with a hashed chunk");
    const patched = (sql.slice(0, last.index) + `${last[1]}, '${"0".repeat(64)}', ${last[3]});` + sql.slice(last.index + last[0].length)).replace(`current_database() <> '${tgt}'`, `current_database() <> '${tampered}'`);
    const late = psql(tampered, patched);
    assert.match(late.stderr, /restore_chunk_hash_mismatch/);
    for (const table of ["customers", "payments", "cash_movements", "marketing_spend_entries"]) assert.equal(count(tampered, table), 0, `${table} was rolled back`);
  });

  await t.test("the restore succeeds on a disposable, empty, marked target and the result equals the source", () => {
    assert.equal(count(tgt, "customers"), 0, "the target starts empty for the organization");
    const result = psql(tgt, sql);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESTORE_RESULT \{.*"verified": true/);
    const restored = fingerprints(tgt, specs);
    const original = fingerprints(source, specs);
    for (const table of specs) assert.equal(restored[table], original[table], `${table} equals the source (count and content)`);
    assert.equal(count(tgt, "customers"), 450);
    assert.equal(report.manifestSha256, (JSON.parse(fs.readFileSync(path.join(archive, ORG, "exports", "00000000-0000-4000-8000-00000000f1f1", "manifest.json"), "utf8")) as { manifestSha256: string }).manifestSha256);
  });

  await t.test("immutable history is still protected after the load, and the neighbour tenant never appeared", () => {
    for (const [table, statement] of [
      ["cash_movements", "update public.cash_movements set amount = 1"], ["cash_movements", "delete from public.cash_movements"],
      ["marketing_spend_entries", "update public.marketing_spend_entries set amount = 1"], ["cash_account_mappings", "delete from public.cash_account_mappings"],
      ["financial_ledger", "update public.financial_ledger set amount = 1"],
    ] as const) {
      const refused = psql(tgt, `${statement};`);
      assert.notEqual(refused.status, 0, `${table}: ${statement}`);
      assert.match(refused.stderr, /immutable|append|restrict|cannot|not allowed/i, table);
    }
    assert.equal(count(tgt, "customers", NEIGHBOUR), 0, "no row of another organization was loaded");
    const mixed = Number(psql(tgt, "select count(*) from public.customers where organization_id <> '" + ORG + "';").stdout.trim());
    assert.equal(mixed, 0);
  });

  await t.test("running the same script again is refused and changes nothing", () => {
    const before = fingerprints(tgt, specs);
    const again = psql(tgt, sql);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /restore_target_not_empty/);
    assert.deepEqual(fingerprints(tgt, specs), before);
  });

  await t.test("another organization already in the target is left exactly as it was", () => {
    const shared = target("shared");
    assert.equal(psql(shared, `insert into public.organizations (id, name, slug, status) values ('${NEIGHBOUR}', 'Neighbour', 'neighbour', 'active');
      insert into public.customers (id, organization_id, display_name, status) values ('f1000000-0000-4000-8000-0000000fffc1', '${NEIGHBOUR}', 'Tetangga', 'active');`).status, 0);
    const before = fingerprints(shared, ["customers"], NEIGHBOUR).customers;
    const result = psql(shared, sql.replace(`current_database() <> '${tgt}'`, `current_database() <> '${shared}'`));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fingerprints(shared, ["customers"], NEIGHBOUR).customers, before);
    assert.equal(count(shared, "customers"), 450);
  });
});
