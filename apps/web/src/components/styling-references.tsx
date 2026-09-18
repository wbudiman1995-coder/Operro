"use client";

import Image from "next/image";
import { startTransition, useActionState, useState } from "react";
import { deleteStylingReferenceAction, uploadStylingReferenceAction, type StylingReferenceActionState } from "@/app/customers/styling-actions";
import { compressPhoto } from "@/lib/image-compression";

export interface StylingReferencePhoto { id: string; petId: string; filename: string; caption: string | null; url: string; expiresAt: string; createdAt: string }
const initialState: StylingReferenceActionState = { error: null, success: null };

export function StylingReferenceUploader({ customerId, pets }: { customerId: string; pets: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(uploadStylingReferenceAction, initialState);
  const [preparing, setPreparing] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPreparing(true);
    const data = new FormData(event.currentTarget); const original = data.get("photo");
    if (original instanceof File) data.set("photo", await compressPhoto(original));
    setPreparing(false); startTransition(() => action(data));
  }
  return <form action={action} onSubmit={submit} className="rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/40 p-4">
    <input type="hidden" name="customerId" value={customerId}/>
    <h3 className="text-sm font-bold text-slate-900">Tambah referensi gaya</h3>
    <p className="mt-1 text-xs leading-5 text-slate-500">Foto privat untuk membantu groomer mengikuti model potongan yang diminta.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold text-slate-600">Hewan<select name="petId" required className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3">{pets.map((pet)=><option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-600">Simpan selama<select name="expiryDays" defaultValue="180" className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3"><option value="30">30 hari</option><option value="90">90 hari</option><option value="180">180 hari</option><option value="365">1 tahun</option></select></label>
      <label className="text-xs font-semibold text-slate-600 sm:col-span-2">Foto<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-2 text-xs"/></label>
      <label className="text-xs font-semibold text-slate-600 sm:col-span-2">Catatan gaya<textarea name="caption" maxLength={300} placeholder="Contoh: badan pendek, telinga tetap panjang" className="mt-1 min-h-20 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm"/></label>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className={`text-xs font-semibold ${state.error?"text-rose-700":"text-emerald-700"}`}>{state.error??state.success??"Foto besar dikompresi otomatis · maksimum 4 MB"}</p><button disabled={pending||preparing} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{preparing?"Menyiapkan…":pending?"Mengunggah…":"Simpan referensi"}</button></div>
  </form>;
}

export function StylingReferenceGallery({ photos, petNames, customerId, canManage=false, compact=false }: { photos: StylingReferencePhoto[]; petNames: Record<string,string>; customerId?: string; canManage?: boolean; compact?: boolean }) {
  if (!photos.length) return null;
  return <div className={compact?"mt-3":"grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>{compact?<p className="mb-2 text-xs font-bold text-violet-800">Referensi gaya pelanggan</p>:null}<div className={compact?"grid grid-cols-3 gap-2":"contents"}>{photos.map((photo)=><article key={photo.id} className="overflow-hidden rounded-2xl border border-violet-100 bg-white shadow-sm"><a href={photo.url} target="_blank" rel="noreferrer" className={`relative block bg-slate-100 ${compact?"aspect-square":"aspect-[4/3]"}`}><Image src={photo.url} alt={`Referensi gaya ${petNames[photo.petId]??"hewan"}`} fill sizes={compact?"140px":"(max-width: 768px) 100vw, 33vw"} className="object-cover"/></a>{!compact?<div className="p-3"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-bold text-slate-800">{petNames[photo.petId]??"Hewan"}</p>{photo.caption?<p className="mt-1 text-xs leading-5 text-slate-500">{photo.caption}</p>:null}<p className="mt-1 text-[10px] text-slate-400">Berlaku sampai {new Date(photo.expiresAt).toLocaleDateString("id-ID")}</p></div>{canManage&&customerId?<form action={deleteStylingReferenceAction}><input type="hidden" name="attachmentId" value={photo.id}/><input type="hidden" name="customerId" value={customerId}/><button className="text-[11px] font-bold text-rose-600">Hapus</button></form>:null}</div></div>:null}</article>)}</div></div>;
}

