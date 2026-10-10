/**
 * E2.4: cross-entity audit viewer (read-only). Requires reports.view; each row is further limited by the capability
 * of the data it describes and by the caller's branch access, enforced inside app.search_audit_events.
 */
import Link from "next/link";

import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { AUDIT_ENTITY_LABELS, loadAuditPage, parseAuditFilters, type AuditQuery } from "@/lib/audit-viewer";
import { loadBranchTimezones } from "@/lib/branch-context";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { formatZonedDateTime } from "@/lib/timezone";

export const metadata = { title: "Riwayat perubahan" };

const ENTITY_LINK: Record<string, (id: string) => string> = {
  customers: (id) => `/customers/${id}`,
  invoices: (id) => `/invoices/${id}`,
};

export default async function AuditPage({ searchParams }: { searchParams: Promise<AuditQuery> }) {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["reports.view"]) {
    return <WorkspaceShell {...workspace} activePath="/audit"><RestrictedNotice title="Tidak ada izin melihat riwayat" description="Peran Anda tidak memiliki izin reports.view, sehingga riwayat perubahan lintas data tidak dapat ditampilkan." /></WorkspaceShell>;
  }
  const query = await searchParams;
  const parsed = parseAuditFilters(query);
  const { defaultTimezone } = await loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id);
  let page = null;
  let error: string | null = parsed.ok ? null : parsed.message;
  if (parsed.ok) {
    try { page = await loadAuditPage(workspace.supabase, parsed.filters, defaultTimezone); }
    catch (cause) { console.error("audit_page_failed", cause); error = "Riwayat belum dapat dimuat. Coba lagi."; }
  }
  const f = parsed.filters;
  const href = (patch: Partial<Record<keyof AuditQuery, string | undefined>>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | undefined> = { table: f.table ?? undefined, action: f.action ?? undefined, actor: f.actor ?? undefined, from: f.from ?? undefined, to: f.to ?? undefined, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const text = next.toString();
    return `/audit${text ? `?${text}` : ""}`;
  };

  return <WorkspaceShell {...workspace} activePath="/audit">
    <PageHeader eyebrow="Kontrol" title="Riwayat perubahan" description="Siapa mengubah apa dan kapan, lintas pelanggan, hewan, booking, invoice, dan pengaturan. Hanya baca." />
    <p className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600">Anda hanya melihat perubahan pada data yang izin dan cabang Anda memang boleh lihat. Nilai yang tampak seperti rahasia (token, hash, kata sandi) disembunyikan. Waktu dalam zona {defaultTimezone}.</p>
    <form method="get" className="mt-5 flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4" aria-label="Filter riwayat">
      <label className="text-[11px] font-semibold text-slate-500">Jenis data
        <select name="table" defaultValue={f.table ?? ""} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs"><option value="">Semua</option>{Object.entries(AUDIT_ENTITY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="text-[11px] font-semibold text-slate-500">Perubahan
        <select name="action" defaultValue={f.action ?? ""} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs"><option value="">Semua</option><option value="INSERT">Dibuat</option><option value="UPDATE">Diperbarui</option><option value="DELETE">Dihapus</option></select></label>
      <label className="text-[11px] font-semibold text-slate-500">Dari<input type="date" name="from" defaultValue={f.from ?? ""} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs" /></label>
      <label className="text-[11px] font-semibold text-slate-500">Sampai<input type="date" name="to" defaultValue={f.to ?? ""} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs" /></label>
      {f.actor ? <input type="hidden" name="actor" value={f.actor} /> : null}
      <button type="submit" className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700">Terapkan</button>
      {f.actor ? <Link href={href({ actor: undefined })} className="text-xs font-semibold text-emerald-700 underline">Hapus filter pengguna</Link> : null}
    </form>
    {error ? <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-xs font-semibold text-rose-700">{error}</p> : null}
    {page && page.rows.length === 0 ? <p className="mt-6 rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">Tidak ada perubahan yang cocok.</p> : null}
    {page && page.rows.length > 0 ? <ul className="mt-5 space-y-3">
      {page.rows.map((row) => {
        const link = row.entityId ? ENTITY_LINK[row.entityTable]?.(row.entityId) : undefined;
        return <li key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-bold text-slate-800">{row.actionLabel} · {row.entityLabel}{link ? <> · <Link href={link} className="text-emerald-700 underline">buka</Link></> : null}</p>
            <p className="text-[11px] text-slate-500">{formatZonedDateTime(row.occurredAt, defaultTimezone)}</p>
          </div>
          <p className="mt-1 text-xs text-slate-500">oleh {row.actorId ? <Link href={href({ actor: row.actorId, cursor: undefined })} className="font-semibold text-slate-700 underline">{row.actorLabel}</Link> : <span className="font-semibold text-slate-700">{row.actorLabel}</span>}</p>
          {row.changes.length > 0 ? <ul className="mt-2 space-y-1 text-xs">{row.changes.map((change) => <li key={change.field} className="flex flex-wrap gap-x-2"><span className="font-semibold text-slate-600">{change.field}:</span><span className="text-slate-400 line-through">{change.before}</span><span className="text-slate-800">{change.after}</span></li>)}</ul> : null}
        </li>;
      })}
    </ul> : null}
    {page?.hasMore && page.nextCursor ? <div className="mt-5 text-center"><Link href={href({ cursor: page.nextCursor })} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700">Muat lebih banyak</Link></div> : null}
  </WorkspaceShell>;
}
