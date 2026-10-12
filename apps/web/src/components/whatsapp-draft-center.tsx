"use client";

import { startTransition, useActionState, useState } from "react";

import {
  createWhatsAppDraftAction,
  setWhatsAppDraftStatusAction,
  setWhatsAppOptOutAction,
  type WhatsAppActionState,
} from "@/app/whatsapp/actions";
import type { WhatsAppDraftRow } from "@/lib/whatsapp-draft-data";
import type { DraftEvent } from "@/lib/whatsapp-batches";
import { SOURCE_LABELS, WHATSAPP_STATUS_LABELS, allowedNextStatuses, blockedReason, maskPhone, waUrl, type WhatsAppSource } from "@/lib/whatsapp-drafts";

const initial: WhatsAppActionState = { error: null, success: null };
const btn = "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50";

function Feedback({ state }: { state: WhatsAppActionState }) {
  return <p aria-live="polite" role="status" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>;
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700", opened: "bg-sky-50 text-sky-800", marked_sent: "bg-emerald-50 text-emerald-800",
  failed: "bg-rose-50 text-rose-700", canceled: "bg-slate-100 text-slate-500",
};

export function DraftRow({ draft, canManageContacts, events }: { draft: WhatsAppDraftRow; canManageContacts: boolean; events?: readonly DraftEvent[] }) {
  const [state, action, pending] = useActionState(setWhatsAppDraftStatusAction, initial);
  const [optState, optAction, optPending] = useActionState(setWhatsAppOptOutAction, initial);
  const [note, setNote] = useState("");
  const next = allowedNextStatuses(draft.status);
  const blocked = blockedReason(draft.sourceType, draft.recipientPhone, draft.health);
  const url = !blocked && (draft.status === "draft" || draft.status === "opened") ? waUrl(draft.recipientPhone, draft.messageText) : null;
  const submit = (status: string) => {
    const data = new FormData();
    data.set("id", draft.id); data.set("status", status); data.set("note", note);
    startTransition(() => action(data));
  };
  return <li className="rounded-2xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-sm font-bold text-slate-800">{SOURCE_LABELS[draft.sourceType]} · {draft.customerName ?? "Calon pelanggan (tanpa nomor)"}</p>
        <p className="text-[11px] text-slate-500">{maskPhone(draft.recipientPhone)} · dibuat {new Date(draft.createdAt).toLocaleString("id-ID")}</p>
      </div>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_TONE[draft.status]}`}>{WHATSAPP_STATUS_LABELS[draft.status]}</span>
    </div>
    {blocked ? <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-800">{blocked} Draf ini tidak dapat dibuka atau ditandai terkirim; masih dapat dibatalkan.</p> : null}
    {draft.health.phoneChanged ? <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">Nomor pelanggan berubah setelah draf dibuat. Draf memakai nomor lama.</p> : null}
    {draft.sourceType === "onboarding" ? <p className="mt-2 text-[11px] text-slate-500">Tautan sekali pakai tidak disimpan. Kirim dari halaman Onboarding saat tautan dibuat; di sini hanya status yang Anda laporkan.</p> : null}
    <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-emerald-700">Lihat isi pesan</summary>
      <p className="mt-2 whitespace-pre-line rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-700">{draft.messageText}</p></details>
    {draft.statusNote ? <p className="mt-2 text-[11px] text-slate-500">Catatan: {draft.statusNote}</p> : null}
    {events && events.length > 0 ? <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-slate-600">Riwayat ({events.length}) — catatan pengguna, bukan konfirmasi WhatsApp</summary>
      <ol className="mt-2 space-y-1 text-[11px] text-slate-600">{events.map((event) => <li key={event.id}>{new Date(event.occurredAt).toLocaleString("id-ID")} · {event.from ? `${WHATSAPP_STATUS_LABELS[event.from].split(" (")[0]} → ` : "dibuat: "}{WHATSAPP_STATUS_LABELS[event.to].split(" (")[0]}{event.actor ? ` · ${event.actor}` : ""}{event.note ? ` · “${event.note}”` : ""}</li>)}</ol></details> : null}
    <p className="mt-1 text-[11px] text-slate-400">Status terakhir diubah {new Date(draft.statusChangedAt).toLocaleString("id-ID")}{draft.statusChangedBy ? ` oleh ${draft.statusChangedBy}` : ""}. Ini catatan pengguna, bukan konfirmasi dari WhatsApp.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {url ? <a href={url} target="_blank" rel="noreferrer" onClick={() => { if (draft.status === "draft") submit("opened"); }} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white">Buka di WhatsApp</a> : null}
      {next.includes("marked_sent") && !blocked ? <button type="button" disabled={pending} onClick={() => submit("marked_sent")} className={btn}>Tandai terkirim</button> : null}
      {next.includes("failed") ? <button type="button" disabled={pending} onClick={() => submit("failed")} className={btn}>Tandai gagal</button> : null}
      {next.includes("draft") ? <button type="button" disabled={pending} onClick={() => submit("draft")} className={btn}>Coba lagi</button> : null}
      {next.includes("canceled") ? <button type="button" disabled={pending} onClick={() => submit("canceled")} className={btn}>Batalkan</button> : null}
      {next.length > 0 ? <label className="text-[11px] font-semibold text-slate-500">Catatan <input value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} className="ml-1 h-8 w-44 rounded-lg border border-slate-200 px-2 text-xs" /></label> : null}
    </div>
    <Feedback state={state} />
    {draft.customerId && canManageContacts ? <form action={optAction} className="mt-2 flex items-center gap-2">
      <input type="hidden" name="customerId" value={draft.customerId} />
      <input type="hidden" name="optedOut" value={draft.health.optedOut ? "false" : "true"} />
      <button type="submit" disabled={optPending} className="text-[11px] font-semibold text-slate-500 underline">{draft.health.optedOut ? "Izinkan pelanggan ini menerima draf lagi" : "Pelanggan berhenti menerima pesan"}</button>
      <Feedback state={optState} />
    </form> : null}
  </li>;
}

export function CreateDraftButton({ sourceType, sourceId, disabledReason }: { sourceType: Exclude<WhatsAppSource, "onboarding">; sourceId: string; disabledReason?: string | null }) {
  const [state, action, pending] = useActionState(createWhatsAppDraftAction, initial);
  return <form action={action} className="flex flex-wrap items-center gap-2">
    <input type="hidden" name="sourceType" value={sourceType} />
    <input type="hidden" name="sourceId" value={sourceId} />
    <button type="submit" disabled={pending || Boolean(disabledReason)} title={disabledReason ?? undefined} className={btn}>{pending ? "Membuat…" : "Buat draf"}</button>
    {disabledReason ? <span className="text-[11px] text-amber-700">{disabledReason}</span> : null}
    <Feedback state={state} />
  </form>;
}
