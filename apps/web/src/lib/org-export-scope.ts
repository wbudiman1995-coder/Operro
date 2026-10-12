/**
 * Function index:
 * - parseExportScope: shapes app.org_export_scope() output (defensively; unknown classes become "not_reviewed").
 * - UNCOVERED_CLASS_LABELS: why a tenant table is not in the archive, in plain language.
 * - compareManifestToScope: per table, rows in a finished archive versus rows in the workspace now (pure).
 * - summarizeScope: totals for display.
 *
 * The scope report is transparency, not a guarantee: an archive is a point-in-time export of the reviewed tables only (see
 * migration 20261031130000). Nothing here proves an archive can be restored.
 */
import type { ExportManifest } from "./org-export-manifest";

export const UNCOVERED_CLASSES = ["secret", "access", "operator", "bookkeeping", "sensitive", "configuration", "no_uuid_cursor", "not_reviewed"] as const;
export type UncoveredClass = (typeof UNCOVERED_CLASSES)[number];

export const UNCOVERED_CLASS_LABELS: Record<UncoveredClass, string> = {
  secret: "Tidak diekspor: menyimpan hash token atau rahasia",
  access: "Tidak diekspor: identitas dan hak akses tidak dapat dipindahkan",
  operator: "Tidak diekspor: data tagihan/entitlement milik operator Operro",
  bookkeeping: "Tidak diekspor: pembukuan internal export dan pembersihan",
  sensitive: "Sengaja tidak diekspor: berisi data sensitif (rekening bank, payload pesan, pengajuan pendaftaran)",
  configuration: "Sudah ada di berkas konfigurasi arsip (bukan sebagai tabel)",
  no_uuid_cursor: "Belum dapat diekspor: tidak punya kunci id uuid untuk halaman terurut",
  not_reviewed: "Belum ditinjau: tabel ini BELUM masuk arsip",
};

export interface ScopeIncluded { table: string; sortOrder: number; reason: string; rowCount: number }
export interface ScopeUncovered { table: string; rowCount: number; capped: boolean; cls: UncoveredClass }
export interface ExportScope {
  generatedAt: string;
  fingerprint: string;
  included: ScopeIncluded[];
  uncovered: ScopeUncovered[];
  retention: { failedOrCancelledDays: number; completedDays: number; keepsNewestCompleted: boolean };
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => { const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : 0; };

export function parseExportScope(data: unknown): ExportScope | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Row;
  if (!Array.isArray(root.included) || !Array.isArray(root.uncovered) || typeof root.fingerprint !== "string") return null;
  const retention = (root.retention ?? {}) as Row;
  return {
    generatedAt: String(root.generated_at ?? ""),
    fingerprint: root.fingerprint,
    included: (root.included as Row[]).flatMap((row) => (typeof row.table === "string" ? [{ table: row.table, sortOrder: num(row.sort_order), reason: String(row.reason ?? ""), rowCount: num(row.row_count) }] : [])),
    uncovered: (root.uncovered as Row[]).flatMap((row) => (typeof row.table === "string"
      ? [{ table: row.table, rowCount: num(row.row_count), capped: row.capped === true, cls: (UNCOVERED_CLASSES as readonly string[]).includes(String(row.class)) ? (row.class as UncoveredClass) : "not_reviewed" }] : [])),
    retention: { failedOrCancelledDays: num(retention.failed_or_cancelled_days) || 7, completedDays: num(retention.completed_days) || 90, keepsNewestCompleted: retention.keeps_newest_completed !== false },
  };
}

export interface ScopeDrift { table: string; exported: number; current: number; delta: number }

/** Only tables present in the archive are compared; a table added to the allowlist after the export shows as "not in this archive". */
export function compareManifestToScope(manifest: Pick<ExportManifest, "tables">, scope: ExportScope): { rows: ScopeDrift[]; notInArchive: string[]; changed: number } {
  const exported = new Map(manifest.tables.map((table) => [table.name, table.rowCount]));
  const rows: ScopeDrift[] = [];
  for (const entry of scope.included) {
    const before = exported.get(entry.table);
    if (before === undefined) continue;
    rows.push({ table: entry.table, exported: before, current: entry.rowCount, delta: entry.rowCount - before });
  }
  const notInArchive = scope.included.filter((entry) => !exported.has(entry.table)).map((entry) => entry.table);
  return { rows, notInArchive, changed: rows.filter((row) => row.delta !== 0).length };
}

export function summarizeScope(scope: ExportScope): { includedTables: number; includedRows: number; uncoveredByClass: Record<UncoveredClass, number>; unreviewedWithData: number } {
  const uncoveredByClass = Object.fromEntries(UNCOVERED_CLASSES.map((cls) => [cls, 0])) as Record<UncoveredClass, number>;
  for (const entry of scope.uncovered) uncoveredByClass[entry.cls] += 1;
  return {
    includedTables: scope.included.length,
    includedRows: scope.included.reduce((total, entry) => total + entry.rowCount, 0),
    uncoveredByClass,
    unreviewedWithData: scope.uncovered.filter((entry) => (entry.cls === "not_reviewed" || entry.cls === "no_uuid_cursor") && entry.rowCount > 0).length,
  };
}
