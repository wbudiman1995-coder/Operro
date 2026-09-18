"use client";

import Image from "next/image";
import { startTransition, useActionState, useState } from "react";

import { uploadGroomingEvidenceAction, type PilotActionState } from "@/app/pilot-actions";
import { compressPhoto } from "@/lib/image-compression";

const initialState: PilotActionState = { error: null, success: null };

export function GroomingEvidenceForm({ bookingId, petJobId }: { bookingId: string; petJobId: string }) {
  const [state, action, pending] = useActionState(uploadGroomingEvidenceAction, initialState);
  const [preparing, setPreparing] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreparing(true);
    const data = new FormData(event.currentTarget);
    const original = data.get("photo");
    if (original instanceof File) data.set("photo", await compressPhoto(original));
    setPreparing(false);
    startTransition(() => action(data));
  }

  return <form action={action} onSubmit={submit} className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
    <input type="hidden" name="bookingId" value={bookingId} />
    <input type="hidden" name="petJobId" value={petJobId} />
    <p className="text-xs font-bold text-slate-800">Dokumentasi layanan</p>
    <div className="mt-2 grid gap-2 sm:grid-cols-[130px_1fr]">
      <select name="category" defaultValue="before" className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold">
        <option value="before">Sebelum</option><option value="after">Sesudah</option><option value="attendance">Kehadiran</option><option value="ear">Telinga</option><option value="hygiene">Area higienis</option><option value="dematting">Dematting</option><option value="fungal">Kondisi jamur</option><option value="injury">Cedera</option><option value="other">Lainnya</option>
      </select>
      <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required className="min-w-0 rounded-lg border border-slate-200 bg-white p-2 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-emerald-50 file:px-2 file:py-1 file:text-xs file:font-bold file:text-emerald-800" />
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <p className={`text-[11px] font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success ?? "Foto besar dikompresi otomatis · maksimum 4 MB"}</p>
      <button disabled={pending || preparing} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{preparing ? "Menyiapkan…" : pending ? "Mengunggah…" : "Unggah foto"}</button>
    </div>
  </form>;
}

export function GroomingEvidenceGallery({ evidence }: { evidence: Array<{ id: string; category: string; filename: string; url: string; createdAt: string }> }) {
  if (evidence.length === 0) return null;
  return <div className="mt-3"><p className="mb-2 text-xs font-bold text-slate-700">Foto tersimpan ({evidence.length})</p><div className="grid grid-cols-3 gap-2">{evidence.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100"><Image src={item.url} alt={`${item.category}: ${item.filename}`} fill sizes="(max-width: 640px) 30vw, 160px" className="object-cover" /><span className="absolute inset-x-0 bottom-0 bg-black/65 px-1.5 py-1 text-[9px] font-bold capitalize text-white">{item.category}</span></a>)}</div></div>;
}
