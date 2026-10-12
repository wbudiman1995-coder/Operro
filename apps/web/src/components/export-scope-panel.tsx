/**
 * Function index:
 * - ExportScopePanel: what the organization archive covers and what it does not, with live row counts and (when a finished
 *   archive exists) how the workspace has changed since it was made. Read-only and owner-only (the data comes from
 *   app.org_export_scope, which the database restricts to the business owner).
 *
 * Transparency, not assurance: a table that is "not reviewed" is NOT in the archive, whatever data it holds.
 */
import { summarizeScope, UNCOVERED_CLASS_LABELS, type ExportScope, type ScopeDrift } from "@/lib/org-export-scope";

export function ExportScopePanel({ scope, drift, driftJobDate }: {
  scope: ExportScope | null;
  drift: { rows: ScopeDrift[]; notInArchive: string[]; changed: number } | null;
  driftJobDate: string | null;
}) {
  if (!scope) {
    return <section aria-label="Cakupan arsip" className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-xs text-slate-600">Cakupan arsip belum dapat dimuat (hanya pemilik bisnis, atau migrasi 20261031130000 belum diterapkan). Ini bukan tanda bahwa semua data tercakup.</section>;
  }
  const summary = summarizeScope(scope);
  const attention = scope.uncovered.filter((entry) => (entry.cls === "not_reviewed" || entry.cls === "no_uuid_cursor") && entry.rowCount > 0);
  return (
    <section aria-label="Cakupan arsip" className="mt-4 rounded-2xl border bg-white p-5">
      <h3 className="font-bold">Cakupan arsip</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        Arsip memuat {summary.includedTables} tabel yang sudah ditinjau ({summary.includedRows.toLocaleString("id-ID")} baris saat ini), konfigurasi workspace, dan metadata file Storage. Isi file Storage, akun login, hak akses, dan rahasia penyedia tidak ikut. Sidik cakupan {scope.fingerprint.slice(0, 12)}…: dua arsip dengan sidik sama dibuat dengan daftar tabel yang sama.
      </p>
      {attention.length > 0 ? (
        <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          {attention.length} tabel berisi data tetapi <strong>belum masuk arsip</strong>: {attention.map((entry) => `${entry.table} (${entry.rowCount.toLocaleString("id-ID")}${entry.capped ? "+" : ""})`).join(", ")}. Arsip ini belum merupakan salinan lengkap organisasi.
        </p>
      ) : null}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-semibold text-emerald-700">Tabel yang dicakup ({summary.includedTables})</summary>
        <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">{scope.included.map((entry) => <li key={entry.table} className="flex justify-between gap-3"><span>{entry.table}</span><span className="tabular-nums text-slate-500">{entry.rowCount.toLocaleString("id-ID")}</span></li>)}</ul>
      </details>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer font-semibold text-emerald-700">Tidak dicakup ({scope.uncovered.length})</summary>
        <ul className="mt-2 space-y-1">{scope.uncovered.map((entry) => <li key={entry.table}><span className="font-semibold">{entry.table}</span> <span className="tabular-nums text-slate-500">({entry.rowCount.toLocaleString("id-ID")}{entry.capped ? "+" : ""})</span> — <span className="text-slate-600">{UNCOVERED_CLASS_LABELS[entry.cls]}</span></li>)}</ul>
      </details>
      {drift && driftJobDate ? (
        <div className="mt-3 text-xs">
          <p className="font-semibold text-slate-700">Dibanding arsip selesai terakhir ({driftJobDate}): {drift.changed === 0 ? "jumlah baris sama" : `${drift.changed} tabel berubah sejak arsip dibuat`}.</p>
          {drift.changed > 0 ? <ul className="mt-1 space-y-0.5 text-slate-600">{drift.rows.filter((row) => row.delta !== 0).map((row) => <li key={row.table}>{row.table}: {row.exported.toLocaleString("id-ID")} → {row.current.toLocaleString("id-ID")} ({row.delta > 0 ? "+" : ""}{row.delta.toLocaleString("id-ID")})</li>)}</ul> : null}
          {drift.notInArchive.length > 0 ? <p className="mt-1 text-slate-500">Tabel yang belum ada di arsip itu: {drift.notInArchive.join(", ")}.</p> : null}
        </div>
      ) : null}
      <p className="mt-3 text-[11px] text-slate-400">Masa simpan: arsip gagal atau dibatalkan lebih dari {scope.retention.failedOrCancelledDays} hari dan arsip selesai lebih dari {scope.retention.completedDays} hari dapat dihapus berkasnya; arsip selesai terbaru selalu dipertahankan.</p>
    </section>
  );
}
