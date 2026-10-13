/**
 * Function index:
 * - generateRestoreSql: turns a VERIFIED organization-export archive plus a description of a disposable target into one guarded SQL
 *   transaction (and a report). It opens no connection and writes nothing; the operator runs the SQL with psql against the
 *   disposable database they named.
 * - RestoreRefused: thrown-free result type for every reason generation is refused.
 *
 * Safety is built into the SQL itself, so it holds even if the file is run somewhere unintended:
 *   1. the database name must equal the name given at generation (an operator-stated disposable target);
 *   2. a marker table public.operro_restore_target must exist and say 'disposable' (no migration creates it; production never has it);
 *   3. app.schema_version() must equal the version the plan was made against;
 *   4. the organization row must already exist in the target and the target must hold no rows for it in any table to be loaded;
 *   5. every chunk is re-hashed in the database against the manifest before it is parsed, and every row must carry the archive's
 *      organization id;
 *   6. rows are loaded INSERT-only with session_replication_role = replica, so append-only and audit triggers are not re-fired and
 *      financial history is neither rewritten nor re-audited;
 *   7. after loading, each row is compared with what was stored, each table's row count and id-list hash must equal the archive's, and
 *      every append-only trigger must still be enabled; any failure aborts and rolls the whole transaction back.
 * It refuses unknown or unsafe tables, credential-like columns, an archive that fails verification, a non-empty target, and a target name
 * that looks like production (a speed bump, not a control: the marker table and emptiness checks are the controls).
 * It does NOT restore Storage object bodies, Auth identities, memberships or provider credentials, and it makes no recovery claim.
 */
import { planRestoreReadiness, type PlanStep, type RestorePlan } from "./org-export-restore-plan";
import { sha256, stableJson, type ExportManifest } from "./org-export-manifest";

export const RESTORE_REPORT_FORMAT = "operro-restore-report" as const;
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/;
const PRODUCTION_LOOKING = /(^|[^a-z])(prod|production|live|main)([^a-z]|$)/i;

export interface RestoreReportTable { name: string; rows: number; idsSha256: string; mode: PlanStep["mode"]; cyclic: boolean }
export interface RestoreReport {
  format: typeof RESTORE_REPORT_FORMAT; version: 1; generatedAt: string;
  organizationId: string; manifestSha256: string; targetDatabase: string; targetSchemaVersion: string;
  tables: RestoreReportTable[]; totalRows: number; externalReferences: RestorePlan["externalReferences"]; warnings: string[];
  sqlSha256: string; reportSha256: string;
}
export type RestoreGeneration =
  | { ok: true; sql: string; report: RestoreReport; plan: RestorePlan }
  | { ok: false; failures: string[]; plan: RestorePlan | null };

type Row = Record<string, unknown>;

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
function dollarTag(text: string, base: string): string {
  for (let n = 0; ; n += 1) {
    const tag = `$${base}${n === 0 ? "" : n}$`;
    if (!text.includes(tag)) return tag;
  }
}
function dollarQuote(text: string, base: string): string {
  const tag = dollarTag(text, base);
  return `${tag}${text}${tag}`;
}

export function idsHash(ids: readonly string[]): string {
  // Plain code-unit order, which equals ORDER BY id::text COLLATE "C" for lower-case uuid text.
  return sha256([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n"));
}

const HELPERS = String.raw`
create function pg_temp.restore_load_chunk(p_table text, p_org uuid, p_text text, p_sha text, p_rows integer) returns integer
language plpgsql as $f$
declare v_rows jsonb; v_cols text; v_n integer; v_bad integer;
begin
  if encode(sha256(convert_to(p_text, 'UTF8')), 'hex') <> p_sha then raise exception 'restore_chunk_hash_mismatch:%', p_table; end if;
  select coalesce(jsonb_agg(l::jsonb), '[]'::jsonb) into v_rows from unnest(string_to_array(p_text, E'\n')) l where l <> '';
  if jsonb_array_length(v_rows) <> p_rows then raise exception 'restore_chunk_row_count_mismatch:%', p_table; end if;
  if exists (select 1 from jsonb_array_elements(v_rows) r where (r ->> 'organization_id') is distinct from p_org::text) then
    raise exception 'restore_foreign_organization_row:%', p_table; end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
  execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)', p_table, v_cols, v_cols, p_table) using v_rows;
  get diagnostics v_n = row_count;
  if v_n <> p_rows then raise exception 'restore_inserted_row_count_mismatch:%', p_table; end if;
  -- what was stored must equal what the archive row parses to (typed comparison, independent of time-zone rendering)
  execute format('select count(*) from jsonb_array_elements($1) r join public.%I t on t.id = (r ->> ''id'')::uuid and t.organization_id = $2 where to_jsonb(t) <> to_jsonb(jsonb_populate_record(null::public.%I, r))', p_table, p_table)
    into v_bad using v_rows, p_org;
  if v_bad <> 0 then raise exception 'restore_row_mismatch:%', p_table; end if;
  return v_n;
end $f$;

create function pg_temp.restore_verify_table(p_table text, p_org uuid, p_count integer, p_ids_sha text) returns void
language plpgsql as $f$
declare v_n bigint; v_hash text;
begin
  execute format('select count(*), encode(sha256(convert_to(coalesce(string_agg(id::text, E''\n'' order by id::text collate "C"), ''''), ''UTF8'')), ''hex'') from public.%I where organization_id = $1', p_table)
    into v_n, v_hash using p_org;
  if v_n <> p_count then raise exception 'restore_table_count_mismatch:%:%<>%', p_table, v_n, p_count; end if;
  if v_hash <> p_ids_sha then raise exception 'restore_table_ids_mismatch:%', p_table; end if;
end $f$;
`;

export function generateRestoreSql(args: {
  manifest: unknown; read: (path: string) => string | null; probe: unknown; targetDatabase: string; now?: Date;
}): RestoreGeneration {
  const failures: string[] = [];
  if (typeof args.targetDatabase !== "string" || !DATABASE_NAME.test(args.targetDatabase)) failures.push("target_database_invalid");
  else if (PRODUCTION_LOOKING.test(args.targetDatabase)) failures.push("target_database_looks_like_production");
  const plan = planRestoreReadiness(args.manifest, args.read, args.probe);
  if (!plan.ok) return { ok: false, failures: [...failures, ...plan.failures], plan };
  if (failures.length > 0) return { ok: false, failures, plan };

  const manifest = args.manifest as ExportManifest;
  const probe = args.probe as { schemaVersion?: unknown };
  const schemaVersion = typeof probe.schemaVersion === "string" && /^[0-9]{14}$/.test(probe.schemaVersion) ? probe.schemaVersion : null;
  if (!schemaVersion) return { ok: false, failures: ["probe_schema_version_unknown"], plan };
  const orgId = manifest.organization.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(orgId)) return { ok: false, failures: ["organization_id_invalid"], plan };
  const byName = new Map(manifest.tables.map((table) => [table.name, table]));

  const loadStatements: string[] = [];
  const verifyStatements: string[] = [];
  const reportTables: RestoreReportTable[] = [];
  const emptyChecks: string[] = [];
  const insertOnly: string[] = [];
  for (const step of plan.order) {
    if (!TABLE_NAME.test(step.table)) return { ok: false, failures: [`table_name_invalid:${step.table}`], plan };
    const table = byName.get(step.table);
    if (!table) return { ok: false, failures: [`table_missing_in_manifest:${step.table}`], plan };
    const ids: string[] = [];
    emptyChecks.push(quote(step.table));
    if (step.mode === "insert_only") insertOnly.push(quote(step.table));
    for (const chunk of table.chunks) {
      const text = args.read(chunk.path);
      if (text === null) return { ok: false, failures: [`chunk_missing:${chunk.path}`], plan };
      for (const line of text.split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as Row;
        if (typeof row.id !== "string") return { ok: false, failures: [`row_without_id:${chunk.path}`], plan };
        ids.push(row.id);
      }
      loadStatements.push(`select pg_temp.restore_load_chunk(${quote(step.table)}, ${quote(orgId)}::uuid, ${dollarQuote(text, "c")}, ${quote(chunk.sha256)}, ${chunk.rowCount});`);
    }
    const hash = idsHash(ids);
    verifyStatements.push(`select pg_temp.restore_verify_table(${quote(step.table)}, ${quote(orgId)}::uuid, ${ids.length}, ${quote(hash)});`);
    reportTables.push({ name: step.table, rows: ids.length, idsSha256: hash, mode: step.mode, cyclic: step.cyclic === true });
  }

  const manifestSha = String(manifest.manifestSha256);
  const sql = [
    "-- Operro organization restore script (generated by apps/web/scripts/restore-org-export.ts).",
    "-- DISPOSABLE TARGET ONLY. It aborts unless the guards below pass. Never run it against production. A pass is not a recovery claim.",
    `-- archive manifest sha256: ${manifestSha}`,
    `-- organization: ${orgId}`,
    `-- target database (must match current_database()): ${args.targetDatabase}`,
    `-- target schema version at planning time: ${schemaVersion}`,
    `-- tables: ${reportTables.length}, rows: ${reportTables.reduce((total, table) => total + table.rows, 0)}`,
    "\\set ON_ERROR_STOP on",
    "begin;",
    "",
    "-- 1. Guards (any failure aborts the whole transaction).",
    "do $guard$",
    "declare v_kinds text[];",
    "begin",
    `  if current_database() <> ${quote(args.targetDatabase)} then raise exception 'restore_wrong_database:expected %, running in %', ${quote(args.targetDatabase)}, current_database(); end if;`,
    "  if to_regclass('public.operro_restore_target') is null then raise exception 'restore_target_marker_missing'; end if;",
    "  execute 'select array_agg(kind) from public.operro_restore_target' into v_kinds;",
    "  if v_kinds is distinct from array['disposable']::text[] then raise exception 'restore_target_not_marked_disposable'; end if;",
    `  if app.schema_version() <> ${quote(schemaVersion)} then raise exception 'restore_schema_version_mismatch:expected ${schemaVersion}, found %', app.schema_version(); end if;`,
    `  if not exists (select 1 from public.organizations o where o.id = ${quote(orgId)}::uuid) then raise exception 'restore_organization_row_missing'; end if;`,
    "end $guard$;",
    "",
    "-- 2. Immutable history is loaded, never re-fired: user triggers (append-only, audit) are bypassed for this transaction only.",
    "set local session_replication_role = replica;",
    HELPERS.trim(),
    "",
    "-- 3. The target must hold nothing for this organization in any table that will be loaded.",
    "do $empty$",
    "declare t text; v_dummy integer;",
    "begin",
    `  foreach t in array array[${emptyChecks.join(", ")}] loop`,
    `    if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = t and c.relkind = 'r') <> 1 then raise exception 'restore_unknown_table:%', t; end if;`,
    `    execute format('select 1 from public.%I where organization_id = %L limit 1', t, ${quote(orgId)}) into v_dummy;`,
    "    if v_dummy is not null then raise exception 'restore_target_not_empty:%', t; end if;",
    "  end loop;",
    "end $empty$;",
    "",
    "-- 4. Load, in dependency order, INSERT only.",
    ...loadStatements,
    "",
    "-- 5. Every table must now hold exactly the archive's rows (count and id-list hash).",
    ...verifyStatements,
    "",
    "-- 6. Append-only protection must still be in place after the load.",
    "do $triggers$",
    "declare t text; v_missing text[] := '{}';",
    "begin",
    `  foreach t in array array[${insertOnly.length > 0 ? insertOnly.join(", ") : "''"}]::text[] loop`,
    "    if t <> '' and not exists (",
    "      select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid",
    "       where g.tgrelid = format('public.%I', t)::regclass and not g.tgisinternal and g.tgenabled in ('O', 'A')",
    "         and p.proname ~ '(block_update|block_hard_delete|immutable|append_only)') then v_missing := v_missing || t; end if;",
    "  end loop;",
    "  if cardinality(v_missing) > 0 then raise exception 'restore_immutability_trigger_missing:%', v_missing; end if;",
    "end $triggers$;",
    "",
    `select 'RESTORE_RESULT ' || jsonb_build_object('manifestSha256', ${quote(manifestSha)}, 'organizationId', ${quote(orgId)}, 'database', current_database(), 'tables', ${reportTables.length}, 'rows', ${reportTables.reduce((total, table) => total + table.rows, 0)}, 'verified', true)::text as result;`,
    "commit;",
    "",
  ].join("\n");

  const finalSql = sql;

  const base: Omit<RestoreReport, "reportSha256"> = {
    format: RESTORE_REPORT_FORMAT, version: 1, generatedAt: (args.now ?? new Date()).toISOString(),
    organizationId: orgId, manifestSha256: manifestSha, targetDatabase: args.targetDatabase, targetSchemaVersion: schemaVersion,
    tables: reportTables, totalRows: reportTables.reduce((total, table) => total + table.rows, 0),
    externalReferences: plan.externalReferences, warnings: plan.warnings, sqlSha256: sha256(finalSql),
  };
  const report: RestoreReport = { ...base, reportSha256: sha256(stableJson(base)) };
  return { ok: true, sql: finalSql, report, plan };
}
