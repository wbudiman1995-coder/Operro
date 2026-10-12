/**
 * P3 WhatsApp batch workflow: pick invoice / follow-up / renewal sources, preview eligibility and messages, create a batch
 * of DRAFTS, then record outcomes one by one. Operro sends nothing; every outcome is a user report (see /whatsapp).
 */
import Link from "next/link";

import { BatchComposer, type BatchCandidate } from "@/components/whatsapp-batch-composer";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { BATCH_LIMIT, BATCH_SOURCES, canBatchSource, isBatchSource, loadBatches, type BatchCursor, type BatchSourceType } from "@/lib/whatsapp-batches";
import { loadDraftCandidates, type DraftCandidates } from "@/lib/whatsapp-draft-data";
import { SOURCE_LABELS } from "@/lib/whatsapp-drafts";

export const metadata = { title: "Batch WhatsApp" };
export const dynamic = "force-dynamic";

const CURSOR = /^(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function parseCursor(raw: string | undefined): BatchCursor | null {
  const match = raw ? CURSOR.exec(raw) : null;
  if (!match || Number.isNaN(Date.parse(match[1]))) return null;
  return { createdAt: new Date(match[1]).toISOString(), id: match[2] };
}

function toCandidates(source: BatchSourceType, candidates: DraftCandidates): BatchCandidate[] | null {
  const noPhone = "Nomor WhatsApp tidak tersedia";
  if (source === "invoice") return candidates.invoices?.map((invoice) => ({ id: invoice.id, label: `${invoice.invoiceNumber} · ${invoice.customerName}`, hint: null, disabledReason: invoice.hasPhone ? null : noPhone })) ?? null;
  if (source === "followup") return candidates.followups?.map((group) => ({ id: group.customerId, label: group.customerName, hint: `${group.petsTotal} hewan perlu dikunjungi`, disabledReason: group.phone ? null : noPhone })) ?? null;
  return candidates.renewals?.flatMap((group) => group.memberships.map((membership) => ({ id: membership.id, label: `${group.customerName} · ${membership.packageName}`, hint: membership.expiresAt ? `berakhir ${membership.expiresAt.slice(0, 10)}` : null, disabledReason: group.phone ? null : noPhone }))) ?? null;
}

export default async function WhatsAppBatchesPage({ searchParams }: { searchParams: Promise<{ source?: string; cursor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const allowed = BATCH_SOURCES.filter((source) => canBatchSource(source, workspace.capabilities));
  if (allowed.length === 0) {
    return <WorkspaceShell {...workspace} activePath="/whatsapp"><RestrictedNotice title="Tidak ada izin" description="Batch WhatsApp memerlukan izin melihat invoice, pelanggan, atau paket." /></WorkspaceShell>;
  }
  const params = await searchParams;
  const source: BatchSourceType = isBatchSource(params.source) && allowed.includes(params.source) ? params.source : allowed[0];
  const [candidates, history] = await Promise.all([
    loadDraftCandidates(workspace.supabase, workspace.activeOrganization.id, workspace.capabilities, BATCH_LIMIT),
    loadBatches(workspace.supabase, workspace.activeOrganization.id, parseCursor(params.cursor)),
  ]);
  const list = toCandidates(source, candidates);
  return <WorkspaceShell {...workspace} activePath="/whatsapp">
    <PageHeader eyebrow="Komunikasi" title="Batch WhatsApp" description="Buat banyak draf sekaligus dari invoice, follow-up, atau perpanjangan, lalu catat hasil tiap draf. Operro tidak mengirim apa pun." />
    <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
      Batch hanya membuat draf. Anda membuka tiap draf di WhatsApp sendiri dan melaporkan hasilnya. Status &ldquo;dibuka&rdquo;, &ldquo;ditandai terkirim&rdquo;, dan &ldquo;ditandai gagal&rdquo; adalah catatan pengguna, bukan konfirmasi pengiriman atau pembacaan dari WhatsApp; status terkirim/dibaca otomatis memerlukan integrasi penyedia resmi yang belum dikonfigurasi. Pelanggan yang berhenti menerima pesan, diarsipkan, tanpa nomor, atau sudah punya draf aktif dilewati otomatis. Undangan pendaftaran tidak dapat dibatch karena tautan sekali pakainya tidak disimpan.
    </p>
    <nav aria-label="Jenis sumber" className="mt-6 flex flex-wrap gap-2 text-xs">
      {allowed.map((value) => <Link key={value} href={`/whatsapp/batches?source=${value}`} aria-current={value === source ? "page" : undefined} className={`rounded-full border px-3 py-1 font-bold ${value === source ? "border-emerald-600 text-emerald-700" : "border-slate-200 text-slate-500"}`}>{SOURCE_LABELS[value]}</Link>)}
      <Link href="/whatsapp" className="ml-auto rounded-full border border-slate-200 px-3 py-1 font-bold text-slate-500">Kembali ke Pusat WhatsApp</Link>
    </nav>
    <section className="mt-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Buat batch">
      <h2 className="font-bold">Buat batch: {SOURCE_LABELS[source]}</h2>
      <p className="mt-1 text-xs text-slate-500">Daftar menampilkan sampai {BATCH_LIMIT} sumber terbaru yang memenuhi kriteria halaman asalnya. Pilih lalu lakukan pratinjau; pratinjau tidak menyimpan apa pun.</p>
      <div className="mt-4">{list === null ? <p className="text-xs text-slate-500">Izin untuk sumber ini tidak dimiliki.</p> : <BatchComposer key={source} sourceType={source} candidates={list} />}</div>
    </section>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Riwayat batch">
      <h2 className="font-bold">Riwayat batch</h2>
      {history.rows.length === 0 ? <p className="mt-3 rounded-lg bg-slate-50 p-4 text-xs text-slate-500">Belum ada batch yang dapat Anda lihat.</p> : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-[11px] uppercase text-slate-400"><tr><th className="py-2 pr-3">Dibuat</th><th className="pr-3">Sumber</th><th className="pr-3">Draf</th><th className="pr-3">Sudah ada / dilewati</th><th className="pr-3">Status</th><th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {history.rows.map((batch) => (
                <tr key={batch.id}>
                  <td className="py-2 pr-3">{new Date(batch.createdAt).toLocaleString("id-ID")}{batch.createdBy ? <span className="block text-slate-400">{batch.createdBy}</span> : null}</td>
                  <td className="pr-3">{SOURCE_LABELS[batch.sourceType]}</td>
                  <td className="pr-3 font-bold">{batch.draftCount}</td>
                  <td className="pr-3">{batch.existingCount} / {batch.skippedCount}</td>
                  <td className="pr-3">{batch.status === "canceled" ? `Dibatalkan (${batch.canceledCount} draf)` : "Aktif"}</td>
                  <td className="text-right"><Link href={`/whatsapp/batches/${batch.id}`} className="font-bold text-emerald-700">Buka</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history.hasMore && history.nextCursor ? <div className="mt-4 text-center"><Link href={`/whatsapp/batches?source=${source}&cursor=${encodeURIComponent(history.nextCursor.createdAt)}_${history.nextCursor.id}`} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700">Muat lebih banyak</Link></div> : null}
    </section>
  </WorkspaceShell>;
}
