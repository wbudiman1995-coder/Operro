/**
 * One batch: counts per user-reported status, each draft with its open/outcome controls and delivery-log history, and
 * the batch-level cancel. Everything shown after "draft" is what a person reported, not WhatsApp-confirmed delivery.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { DraftRow } from "@/components/whatsapp-draft-center";
import { CancelBatchButton } from "@/components/whatsapp-batch-composer";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { canBatchSource, loadBatch, loadDraftEvents, summarizeStatuses } from "@/lib/whatsapp-batches";
import { loadWhatsAppDrafts, type DraftCursor } from "@/lib/whatsapp-draft-data";
import { SOURCE_LABELS, WHATSAPP_STATUSES, WHATSAPP_STATUS_LABELS } from "@/lib/whatsapp-drafts";

export const metadata = { title: "Batch WhatsApp" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseCursor(raw: string | undefined): DraftCursor | undefined {
  const separator = raw ? raw.lastIndexOf("_") : -1;
  if (!raw || separator <= 0) return undefined;
  const createdAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  return Number.isNaN(Date.parse(createdAt)) || !UUID.test(id) ? undefined : { createdAt: new Date(createdAt).toISOString(), id };
}

export default async function WhatsAppBatchPage({ params, searchParams }: { params: Promise<{ batchId: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const { batchId } = await params;
  if (!UUID.test(batchId)) notFound();
  const batch = await loadBatch(workspace.supabase, workspace.activeOrganization.id, batchId);
  if (!batch) {
    return <WorkspaceShell {...workspace} activePath="/whatsapp"><RestrictedNotice title="Batch tidak ditemukan" description="Batch ini tidak ada, atau peran Anda tidak memiliki izin untuk sumber pesannya." /></WorkspaceShell>;
  }
  const query = await searchParams;
  const page = await loadWhatsAppDrafts(workspace.supabase, workspace.activeOrganization.id, { batchId, cursor: parseCursor(query.cursor), pageSize: 25 });
  const [events, allDrafts] = await Promise.all([
    loadDraftEvents(workspace.supabase, workspace.activeOrganization.id, page.rows.map((row) => row.id)),
    // Status counts come from the whole batch (at most 25 drafts), not just the visible page.
    loadWhatsAppDrafts(workspace.supabase, workspace.activeOrganization.id, { batchId, pageSize: 25 }),
  ]);
  const counts = summarizeStatuses(allDrafts.rows);
  const live = counts.draft + counts.opened + counts.failed;
  return <WorkspaceShell {...workspace} activePath="/whatsapp">
    <PageHeader eyebrow="Batch WhatsApp" title={`Batch ${SOURCE_LABELS[batch.sourceType]}`} description={`Dibuat ${new Date(batch.createdAt).toLocaleString("id-ID")}${batch.createdBy ? ` oleh ${batch.createdBy}` : ""}. ${batch.draftCount} draf, ${batch.existingCount} sudah ada di antrean, ${batch.skippedCount} dilewati saat dibuat.`} action={<Link href="/whatsapp/batches" className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700">Semua batch</Link>} />
    <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">Operro tidak mengirim pesan dan tidak membaca status WhatsApp. Status di bawah adalah laporan pengguna; riwayat tiap draf dicatat dan tidak dapat diubah.</p>
    <section aria-label="Ringkasan status" className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {WHATSAPP_STATUSES.map((status) => <div key={status} className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{WHATSAPP_STATUS_LABELS[status].split(" (")[0]}</p><p className="mt-1 text-xl font-bold text-slate-900">{counts[status]}</p></div>)}
    </section>
    {batch.status === "canceled" ? <p className="mt-4 rounded-xl bg-slate-100 p-3 text-xs font-semibold text-slate-600">Dibatalkan {batch.canceledAt ? new Date(batch.canceledAt).toLocaleString("id-ID") : ""}{batch.canceledBy ? ` oleh ${batch.canceledBy}` : ""}: {batch.canceledCount} draf aktif dibatalkan.</p> : null}
    {canBatchSource(batch.sourceType, workspace.capabilities) ? <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4"><h2 className="text-sm font-bold">Batalkan batch</h2><div className="mt-2"><CancelBatchButton batchId={batch.id} disabled={live === 0} /></div></section> : null}
    <section className="mt-6" aria-label="Draf dalam batch">
      {page.rows.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">Tidak ada draf dalam batch ini.</p>
        : <ul className="space-y-3">{page.rows.map((row) => <DraftRow key={`${row.id}:${row.status}`} draft={row} canManageContacts={Boolean(workspace.capabilities["customer.manage"])} events={events.get(row.id)} />)}</ul>}
      {page.hasMore && page.nextCursor ? <div className="mt-4 text-center"><Link href={`/whatsapp/batches/${batch.id}?cursor=${encodeURIComponent(page.nextCursor.createdAt)}_${page.nextCursor.id}`} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700">Muat lebih banyak</Link></div> : null}
    </section>
  </WorkspaceShell>;
}
