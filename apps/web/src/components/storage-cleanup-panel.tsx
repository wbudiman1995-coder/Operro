"use client";

import { useActionState, useState, useTransition } from "react";

import {
  applyStorageCleanupAction,
  previewStorageCleanupAction,
  type CleanupApplyState,
  type CleanupPreviewState,
} from "@/app/settings/storage/cleanup-actions";
import type { CleanupRunRow } from "@/lib/storage-cleanup";

const STATUS_LABEL: Record<string, string> = {
  running: "Berjalan", completed: "Selesai", partial: "Sebagian (ada yang perlu dicoba lagi)", failed: "Gagal", abandoned: "Terhenti (lease habis)",
};
const applyInitial: CleanupApplyState = { error: null, summary: null };

/**
 * Preview is a dry run; nothing is deleted until the business owner confirms the exact previewed list. The panel
 * counts objects only: no size totals, database size or prices.
 */
export function StorageCleanupPanel({ runs, canPreview, canApply }: { runs: CleanupRunRow[]; canPreview: boolean; canApply: boolean }) {
  const [previewState, setPreviewState] = useState<CleanupPreviewState>({ error: null, preview: null });
  const [pending, startTransition] = useTransition();
  const [applyState, applyAction, applying] = useActionState(applyStorageCleanupAction, applyInitial);
  const preview = previewState.preview;

  return <section className="mt-6 rounded-2xl border bg-white p-5" aria-labelledby="cleanup-title">
    <h2 id="cleanup-title" className="font-bold">Pembersihan file kedaluwarsa</h2>
    <p className="mt-1 text-xs leading-5 text-slate-500">Menghapus file referensi gaya dan foto grooming yang sudah melewati masa simpan (ditambah 1 hari tenggang) dan tidak dipakai invoice, pembayaran, keluhan, atau data lain. Selalu mulai dengan pratinjau: <strong>pratinjau tidak menghapus apa pun</strong>. Hanya objek yang tampil di pratinjau yang dapat dihapus, dan data di database ditandai terlebih dahulu sebelum file dihapus. Tidak ada perkiraan ukuran database atau penagihan di sini.</p>
    {canPreview ? <button type="button" disabled={pending} onClick={() => startTransition(async () => setPreviewState(await previewStorageCleanupAction()))} className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-60">{pending ? "Membuat pratinjau…" : "Buat pratinjau (dry-run)"}</button> : <p className="mt-3 text-xs text-slate-500">Hanya pengelola pengaturan yang dapat membuat pratinjau.</p>}
    {previewState.error ? <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">{previewState.error}</p> : null}
    {preview ? <div className="mt-4 rounded-xl bg-slate-50 p-4">
      <p className="text-xs font-bold text-slate-700">Pratinjau (dry-run): {preview.candidates} objek akan dihapus. Belum ada yang dihapus.</p>
      {preview.items.length > 0 ? <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-[11px] text-slate-600">{preview.items.map((item) => <li key={`${item.bucket}/${item.path}`}>{item.bucket} · {item.path.split("/").slice(1).join("/")} · {item.reason === "styling_reference_expired" ? "referensi gaya kedaluwarsa" : "foto grooming kedaluwarsa"}</li>)}</ul> : <p className="mt-2 text-xs text-slate-500">Tidak ada yang perlu dibersihkan.</p>}
      {canApply && preview.candidates > 0 ? <form action={applyAction} className="mt-3 space-y-2">
        <input type="hidden" name="previewId" value={preview.runId} />
        <label className="flex items-start gap-2 text-xs text-slate-700"><input type="checkbox" name="confirm" value="yes" className="mt-0.5" /> Saya memahami file ini akan dihapus permanen dan tidak dapat dikembalikan dari Operro.</label>
        <button type="submit" disabled={applying} className="rounded-lg bg-rose-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{applying ? "Menghapus…" : "Jalankan pembersihan sesuai pratinjau"}</button>
      </form> : preview.candidates > 0 ? <p className="mt-3 text-xs text-slate-500">Hanya pemilik bisnis yang dapat menjalankan pembersihan.</p> : null}
    </div> : null}
    {applyState.error ? <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">{applyState.error}</p> : null}
    {applyState.summary ? <p className="mt-3 text-xs font-semibold text-slate-700" role="status">Hasil: {STATUS_LABEL[applyState.summary.status] ?? applyState.summary.status} · {applyState.summary.deleted} dihapus · {applyState.summary.missing} sudah tidak ada di penyimpanan · {applyState.summary.failed} gagal (dicoba lagi nanti) · {applyState.summary.skipped} dilewati karena berubah sejak pratinjau.</p> : null}
    <h3 className="mt-5 text-xs font-bold uppercase text-slate-500">Riwayat proses</h3>
    {runs.length === 0 ? <p className="mt-2 text-xs text-slate-500">Belum ada proses.</p> : <ul className="mt-2 space-y-1.5">{runs.map((run) => <li key={run.id} className="rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">
      {new Date(run.startedAt).toLocaleString("id-ID")} · <strong>{run.mode === "dry_run" ? "Pratinjau (dry-run)" : "Pembersihan"}</strong> · {STATUS_LABEL[run.status] ?? run.status}
      {run.mode === "dry_run" ? ` · ${run.candidateCount} objek terdaftar, tidak ada yang dihapus` : ` · ${run.deletedCount} dihapus · ${run.missingCount} sudah tidak ada · ${run.failedCount} tertunda/gagal · ${run.skippedCount} dilewati`}</li>)}</ul>}
  </section>;
}
