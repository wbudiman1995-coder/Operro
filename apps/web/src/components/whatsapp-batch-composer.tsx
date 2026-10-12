"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import {
  createWhatsAppBatchAction, previewWhatsAppBatchAction, cancelWhatsAppBatchAction,
  type BatchCancelState, type BatchCreateState, type BatchPreviewState,
} from "@/app/whatsapp/batch-actions";
import { BATCH_LIMIT, describeSkipReason, type BatchSourceType } from "@/lib/whatsapp-batches";

export interface BatchCandidate { id: string; label: string; hint: string | null; disabledReason: string | null }

const previewInitial: BatchPreviewState = { error: null, success: null, items: null };
const createInitial: BatchCreateState = { error: null, success: null, batchId: null, items: null };
const cancelInitial: BatchCancelState = { error: null, success: null };
const btn = "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50";

/**
 * Pick sources -> "Pratinjau" (eligibility + the exact message each draft would carry, nothing saved) -> "Buat batch".
 * Messages and recipients are decided by the server and database; this component only sends a source type and ids.
 */
export function BatchComposer({ sourceType, candidates }: { sourceType: BatchSourceType; candidates: readonly BatchCandidate[] }) {
  const [previewState, previewAction, previewing] = useActionState(previewWhatsAppBatchAction, previewInitial);
  const [createState, createAction, creating] = useActionState(createWhatsAppBatchAction, createInitial);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const names = new Map(candidates.map((candidate) => [candidate.id, candidate.label]));
  const selectable = candidates.filter((candidate) => !candidate.disabledReason);
  const toggle = (id: string, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id); else next.delete(id);
    return next;
  });
  const over = selected.size > BATCH_LIMIT;

  return (
    <form className="space-y-4" aria-label="Batch draf WhatsApp">
      <input type="hidden" name="sourceType" value={sourceType} />
      {[...selected].map((id) => <input key={id} type="hidden" name="sourceId" value={id} />)}
      {candidates.length === 0 ? <p className="rounded-lg bg-slate-50 p-4 text-xs text-slate-500">Tidak ada sumber yang dapat dipilih saat ini.</p> : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <button type="button" className={btn} onClick={() => setSelected(new Set(selectable.slice(0, BATCH_LIMIT).map((candidate) => candidate.id)))}>Pilih yang memenuhi syarat (maks. {BATCH_LIMIT})</button>
            <button type="button" className={btn} onClick={() => setSelected(new Set())}>Kosongkan</button>
            <span className="font-semibold text-slate-500" aria-live="polite">{selected.size} dipilih</span>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <label className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${candidate.disabledReason ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
                  <input type="checkbox" checked={selected.has(candidate.id)} disabled={Boolean(candidate.disabledReason)} onChange={(event) => toggle(candidate.id, event.target.checked)} className="mt-0.5 h-4 w-4" />
                  <span><span className="font-semibold text-slate-800">{candidate.label}</span>{candidate.hint ? <span className="block text-slate-500">{candidate.hint}</span> : null}{candidate.disabledReason ? <span className="block font-semibold text-amber-800">{candidate.disabledReason}</span> : null}</span>
                </label>
              </li>
            ))}
          </ul>
          {over ? <p role="alert" className="text-xs font-semibold text-rose-700">Maksimal {BATCH_LIMIT} sumber per batch.</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" formAction={previewAction} disabled={previewing || selected.size === 0 || over} className={btn}>{previewing ? "Memeriksa…" : "Pratinjau (tidak menyimpan)"}</button>
            <button type="submit" formAction={createAction} disabled={creating || selected.size === 0 || over || !previewState.items} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" title={previewState.items ? undefined : "Lakukan pratinjau lebih dulu"}>{creating ? "Membuat…" : "Buat batch draf"}</button>
          </div>
          <p aria-live="polite" className="text-xs font-semibold">
            {previewState.error ? <span className="text-rose-700">{previewState.error}</span> : previewState.success ? <span className="text-emerald-700">{previewState.success}</span> : null}
          </p>
        </>
      )}

      {previewState.items ? (
        <section aria-label="Pratinjau batch" className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-slate-400">Pratinjau</h3>
          <ul className="space-y-2">
            {previewState.items.map((item) => (
              <li key={item.sourceId} className={`rounded-xl border p-3 text-xs ${item.eligible ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
                <p className="font-semibold text-slate-800">{names.get(item.sourceId) ?? item.label ?? "Sumber"} — {item.eligible ? "akan dibuat" : describeSkipReason(item.reason)}</p>
                {item.text ? <details className="mt-1"><summary className="cursor-pointer font-semibold text-emerald-700">Isi pesan</summary><p className="mt-1 whitespace-pre-line rounded-lg bg-white p-2 text-slate-700">{item.text}</p></details> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {createState.error ? <p role="alert" className="text-xs font-semibold text-rose-700">{createState.error}</p> : null}
      {createState.items ? (
        <section aria-label="Hasil batch" className="space-y-2">
          <p className="text-xs font-semibold text-emerald-800">{createState.success}</p>
          <ul className="space-y-1 text-xs">
            {createState.items.map((item) => (
              <li key={item.sourceId} className="text-slate-700"><span className="font-semibold">{names.get(item.sourceId) ?? "Sumber"}</span>: {item.outcome === "created" ? "draf dibuat" : item.outcome === "existing" ? "sudah ada di antrean" : `dilewati — ${describeSkipReason(item.reason)}`}</li>
            ))}
          </ul>
          {createState.batchId ? <Link href={`/whatsapp/batches/${createState.batchId}`} className="inline-block rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white">Buka batch dan catat hasil</Link> : <p className="text-xs text-slate-500">Tidak ada draf baru, jadi tidak ada batch yang dibuat.</p>}
        </section>
      ) : null}
    </form>
  );
}

export function CancelBatchButton({ batchId, disabled }: { batchId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(cancelWhatsAppBatchAction, cancelInitial);
  const [confirm, setConfirm] = useState(false);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="batchId" value={batchId} />
      <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
        <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} disabled={disabled} className="h-4 w-4" />
        Saya mengerti: semua draf aktif (draf, dibuka, gagal) di batch ini akan dibatalkan; yang sudah ditandai terkirim tidak berubah.
      </label>
      <button type="submit" disabled={disabled || pending || !confirm} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 disabled:opacity-50">{pending ? "Membatalkan…" : "Batalkan batch"}</button>
      <p aria-live="polite" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
    </form>
  );
}
