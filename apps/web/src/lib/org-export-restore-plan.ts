/**
 * Function index:
 * - planRestoreReadiness: DRY-RUN readiness check of an extracted organization-export archive against a description of a
 *   DISPOSABLE target database (the output of docs/runbooks/restore-schema-probe.sql). Pure: it reads archive files through a
 *   callback and a schema object; it opens no connection, writes nothing and cannot reach any database.
 * - RESTORE_UNSAFE_TABLE: tables that must never be loaded from an archive even if one were present.
 *
 * What a pass means: the archive is internally intact (hashes, counts, ordering, tenant), every table and column it carries
 * exists in the target schema, nothing in it looks like a credential, every foreign key that points INSIDE the archive is
 * satisfied by the archive, the target holds no rows for that organization yet, and a dependency-safe INSERT-only load order
 * exists. What it does NOT mean: that a restore was performed, that Storage object bodies, Auth identities or provider
 * secrets exist anywhere (they are not in the archive), or that Operro is recoverable. Only a recorded disposable-project
 * drill (docs/runbooks/DISPOSABLE_RESTORE_DRILL.md) proves anything about recovery.
 */
import { FORBIDDEN_EXPORT_KEY, type ExportManifest } from "./org-export-manifest";
import { verifyOrganizationExport, type ExportVerification } from "./org-export-verify";

export const PROBE_FORMAT = "operro-restore-schema-probe" as const;
/** Never loadable from an archive: identities, access control, secrets, operator billing and export/cleanup bookkeeping. */
export const RESTORE_UNSAFE_TABLE = /^(users|memberships|membership_branch_access|roles|role_permissions|customer_onboarding_links|customer_onboarding_submissions|platform_.+|subscriptions|organization_modules|organization_features|organization_export_.+|storage_cleanup_.+|recovery_drills)$/;

export interface TargetForeignKey { columns: string[]; refTable: string; refColumns: string[] }
export interface TargetTable {
  columns: string[];
  /** NOT NULL columns without a default or generation expression. */
  required: string[];
  foreignKeys: TargetForeignKey[];
  /** The table carries an append-only / immutability trigger (financial and audit history). */
  insertOnly: boolean;
  /** Rows the target already holds for the archive's organization. */
  existingRows: number;
}
export interface TargetSchema { format: typeof PROBE_FORMAT; version: 1; schemaVersion: string; organizationId: string; tables: Record<string, TargetTable> }

/** `cyclic`: the table sits in a foreign-key cycle, so no dependency-safe position exists for it (see the plan warning). */
export interface PlanStep { table: string; rows: number; mode: "insert" | "insert_only"; cyclic?: boolean }
export interface ExternalReference { table: string; columns: string[]; refTable: string; distinctValues: number }
export interface RestorePlan {
  ok: boolean;
  failures: string[];
  warnings: string[];
  archive: ExportVerification;
  order: PlanStep[];
  cycles: string[][];
  externalReferences: ExternalReference[];
  summary: { tables: number; rows: number; insertOnlyTables: number };
}

type Row = Record<string, unknown>;
const tupleKey = (row: Row, columns: readonly string[]): string | null => {
  const parts: string[] = [];
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) return null;
    parts.push(String(value));
  }
  return parts.join("\u0001");
};

function parseSchema(value: unknown): TargetSchema | null {
  if (!value || typeof value !== "object") return null;
  const schema = value as Partial<TargetSchema>;
  if (schema.format !== PROBE_FORMAT || schema.version !== 1 || typeof schema.organizationId !== "string" || !schema.tables || typeof schema.tables !== "object") return null;
  return schema as TargetSchema;
}

export function planRestoreReadiness(manifest: unknown, read: (path: string) => string | null, schemaInput: unknown): RestorePlan {
  const failures: string[] = [];
  const warnings: string[] = [];
  const archive = verifyOrganizationExport(manifest, read);
  for (const failure of archive.failures) failures.push(`archive:${failure}`);
  warnings.push(...archive.warnings.map((warning) => `archive:${warning}`));
  const empty = (): RestorePlan => ({ ok: false, failures, warnings, archive, order: [], cycles: [], externalReferences: [], summary: { tables: 0, rows: 0, insertOnlyTables: 0 } });

  const schema = parseSchema(schemaInput);
  if (!schema) { failures.push("schema_probe_invalid"); return empty(); }
  const typed = manifest as Partial<ExportManifest>;
  if (!typed || typeof typed !== "object" || !typed.organization?.id || !Array.isArray(typed.tables)) return empty();
  const orgId = typed.organization.id;
  if (schema.organizationId !== orgId) failures.push("schema_probe_organization_mismatch");

  // Load the archive rows once. Only the columns needed for the checks are retained.
  const inArchive = new Map<string, { rows: Row[]; columns: Set<string> }>();
  for (const table of typed.tables) {
    const rows: Row[] = [];
    const columns = new Set<string>();
    for (const chunk of table.chunks ?? []) {
      const text = read(chunk.path);
      if (text === null) continue; // already reported by the archive verifier
      for (const line of text.split("\n")) {
        if (!line) continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== "object") continue;
        rows.push(row as Row);
        for (const key of Object.keys(row as Row)) columns.add(key);
      }
    }
    inArchive.set(table.name, { rows, columns });
  }

  // 1. table / column compatibility and safety
  for (const [name, { rows, columns }] of inArchive) {
    if (RESTORE_UNSAFE_TABLE.test(name)) { failures.push(`unsafe_table:${name}`); continue; }
    const target = schema.tables[name];
    if (!target) { failures.push(`unknown_table:${name}`); continue; }
    for (const column of [...columns].sort()) {
      if (!target.columns.includes(column)) failures.push(`unknown_column:${name}.${column}`);
      if (FORBIDDEN_EXPORT_KEY.test(column)) failures.push(`forbidden_column:${name}.${column}`);
    }
    if (rows.length > 0) for (const column of target.required) if (!columns.has(column)) failures.push(`missing_required_column:${name}.${column}`);
    if (target.existingRows > 0) failures.push(`target_not_empty:${name}:${target.existingRows}`);
  }

  // 2. foreign keys that point inside the archive must be satisfied by it; the others are reported, not guessed
  const externalReferences: ExternalReference[] = [];
  const edges = new Map<string, Set<string>>();
  for (const [name, { rows }] of inArchive) {
    const target = schema.tables[name];
    if (!target || RESTORE_UNSAFE_TABLE.test(name)) continue;
    edges.set(name, new Set());
    for (const fk of target.foreignKeys) {
      if (fk.refTable === "organizations" || !fk.columns.every((column) => target.columns.includes(column))) continue;
      const referenced = inArchive.get(fk.refTable);
      if (!referenced || RESTORE_UNSAFE_TABLE.test(fk.refTable)) {
        const distinct = new Set<string>();
        for (const row of rows) { const key = tupleKey(row, fk.columns.filter((column) => column !== "organization_id")); if (key !== null) distinct.add(key); }
        if (distinct.size > 0) externalReferences.push({ table: name, columns: fk.columns, refTable: fk.refTable, distinctValues: distinct.size });
        continue;
      }
      if (fk.refTable !== name) edges.get(name)!.add(fk.refTable);
      const known = new Set<string>();
      for (const row of referenced.rows) { const key = tupleKey(row, fk.refColumns); if (key !== null) known.add(key); }
      let dangling = 0;
      for (const row of rows) { const key = tupleKey(row, fk.columns); if (key !== null && !known.has(key)) dangling += 1; }
      if (dangling > 0) failures.push(`fk_dangling:${name}(${fk.columns.join(",")})->${fk.refTable}:${dangling}`);
    }
  }
  for (const reference of externalReferences) warnings.push(`external_reference:${reference.table}.${reference.columns.join(",")}->${reference.refTable} (${reference.distinctValues} distinct) must already exist in the target`);

  // 3. dependency-safe order (Kahn, ties broken by manifest order); leftovers form cycles
  const order: PlanStep[] = [];
  const remaining = new Map([...edges].map(([name, deps]) => [name, new Set(deps)]));
  const manifestOrder = typed.tables.map((table) => table.name).filter((name) => remaining.has(name));
  while (remaining.size > 0) {
    const ready = manifestOrder.find((name) => remaining.has(name) && [...remaining.get(name)!].every((dep) => !remaining.has(dep)));
    if (!ready) break;
    const target = schema.tables[ready];
    order.push({ table: ready, rows: inArchive.get(ready)!.rows.length, mode: target.insertOnly ? "insert_only" : "insert" });
    remaining.delete(ready);
  }
  const cycles: string[][] = remaining.size > 0 ? [[...remaining.keys()]] : [];
  if (cycles.length > 0) {
    // Tables inside (or behind) a foreign-key cycle have no dependency-safe position. They are still part of the load, so they are
    // appended in manifest order and flagged, never silently dropped from the plan.
    for (const name of manifestOrder.filter((candidate) => remaining.has(candidate))) {
      order.push({ table: name, rows: inArchive.get(name)!.rows.length, mode: schema.tables[name].insertOnly ? "insert_only" : "insert", cyclic: true });
    }
    warnings.push(`fk_cycle:${cycles[0].length} tables (${cycles[0].join(",")}) have no dependency-safe order; load them in one transaction with foreign-key triggers bypassed (session_replication_role = replica), then validate every foreign key afterwards`);
  }

  warnings.push("not_in_archive:storage_object_bodies,auth_identities,provider_credentials (restore them separately; this archive is not a backup)");
  const insertOnlyTables = order.filter((step) => step.mode === "insert_only").length;
  if (insertOnlyTables > 0) warnings.push(`load_with_triggers_bypassed:${insertOnlyTables} tables are append-only; load them INSERT-only (session_replication_role = replica) so history is neither rewritten nor re-audited`);
  return {
    ok: failures.length === 0, failures, warnings, archive, order, cycles, externalReferences,
    summary: { tables: order.length, rows: order.reduce((total, step) => total + step.rows, 0), insertOnlyTables },
  };
}
