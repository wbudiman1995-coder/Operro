"use client";

import { useState } from "react";

import { cancelOrganizationExportAction, purgeOrganizationExportAction, startOrganizationExportAction, stepOrganizationExportAction, verifyOrganizationExportAction } from "@/app/settings/storage/export-actions";
import type { ExportJobSummary } from "@/lib/org-export";

const STATUS_LABEL: Record<ExportJobSummary["status"], string> = { running: "belum selesai", completed: "selesai", failed: "gagal", cancelled: "dibatalkan" };

function verificationText(job: ExportJobSummary): string {
  if (job.status !== "completed" || job.purged_at) return "";
  if (!job.verified_at) return " · belum diverifikasi";
  const when = new Date(job.verified_at).toLocaleString("id-ID");
  return job.verified_ok ? ` · metadata terverifikasi ${when}` : ` · verifikasi GAGAL ${when} (${job.verified_failures ?? "?"} temuan)`;
}

export function OrganizationExportPanel({ authorized, jobs, purgeable = [] }: { authorized: boolean; jobs: ExportJobSummary[]; purgeable?: readonly string[] }) {
  const [includeStorage, setIncludeStorage] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = jobs.find((job) => job.status === "running");

  async function drive(jobId: string) {
    let step = await stepOrganizationExportAction(jobId);
    for (let index = 0; index < 10_000 && step.ok && !step.done; index += 1) { setMessage(step.message); step = await stepOrganizationExportAction(jobId); }
    setMessage(step.ok ? step.message : `${step.message} Export tetap tersimpan; tekan "Lanjutkan" untuk mencoba lagi atau batalkan.`);
  }
  async function start() {
    setBusy(true);
    const started = await startOrganizationExportAction(includeStorage);
    setMessage(started.message);
    if (started.ok && started.jobId) await drive(started.jobId);
    setBusy(false);
  }
  async function cancel(jobId: string) { setBusy(true); setMessage((await cancelOrganizationExportAction(jobId)).message); setBusy(false); }
  async function verify(jobId: string) { setBusy(true); setMessage("Memeriksa berkas…"); setMessage((await verifyOrganizationExportAction(jobId)).message); setBusy(false); }
  async function purge(jobId: string) {
    if (!window.confirm("Hapus semua berkas arsip ini dari penyimpanan? Riwayat tetap ada, tetapi arsip tidak dapat dipulihkan atau diverifikasi lagi.")) return;
    setBusy(true); setMessage("Menghapus berkas arsip…"); setMessage((await purgeOrganizationExportAction(jobId)).message); setBusy(false);
  }

  return (
    <section className="mt-6 rounded-2xl border bg-white p-5">
      <h2 className="font-bold">Export data organisasi</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">Membuat arsip JSONL bertanda hash untuk data workspace yang sudah ditinjau, ditambah daftar metadata file Storage (isi file tidak ikut). Ini arsip export, bukan cadangan: belum ada uji pemulihan ke proyek lain, jadi jangan diandalkan untuk pemulihan bencana.</p>
      {!authorized ? <p className="mt-3 text-xs font-semibold text-slate-600">Hanya pemilik bisnis yang dapat membuat atau memverifikasi export.</p> : <>
        <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={includeStorage} onChange={(event) => setIncludeStorage(event.target.checked)} disabled={busy || Boolean(running)} /> Sertakan daftar metadata file Storage</label>
        <button type="button" onClick={start} disabled={busy} className="mt-4 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? "Memproses…" : running ? "Lanjutkan export" : "Mulai export"}</button>
        {message ? <p role="status" className="mt-3 text-xs text-slate-600">{message}</p> : null}
        {jobs.length ? <ul className="mt-4 space-y-2">{jobs.map((job) => (
          <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-xs">
            <span>{new Date(job.created_at).toLocaleString("id-ID")} · <strong>{job.purged_at ? "berkas dihapus" : STATUS_LABEL[job.status]}</strong>{job.status === "running" ? ` (${job.tables_done}/${job.tables_total} tabel)` : ""}{job.failed_reason ? ` · ${job.failed_reason}` : ""}{verificationText(job)}</span>
            <span className="flex gap-2">
              {job.status === "completed" && !job.purged_at ? <button type="button" onClick={() => verify(job.id)} disabled={busy} className="rounded border px-2 py-1 font-semibold disabled:opacity-50">Verifikasi metadata</button> : null}
              {job.status === "running" ? <button type="button" onClick={() => cancel(job.id)} disabled={busy} className="rounded border px-2 py-1 font-semibold disabled:opacity-50">Batalkan</button> : null}
              {purgeable.includes(job.id) ? <button type="button" onClick={() => purge(job.id)} disabled={busy} className="rounded border border-rose-200 px-2 py-1 font-semibold text-rose-700 disabled:opacity-50">Hapus berkas (melewati masa simpan)</button> : null}
            </span>
          </li>))}</ul> : null}
      </>}
    </section>
  );
}
