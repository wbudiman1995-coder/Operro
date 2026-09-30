"use client";

import { useActionState, useState } from "react";
import { amendOnboardingAction, reviewOnboardingAction, type OnboardingActionState } from "@/app/customers/onboarding/actions";
import { BreedSelect } from "@/components/breed-select";
import { IndonesiaRegionFields } from "@/components/indonesia-region-fields";
import { isGoogleMapsLink } from "@/lib/maps";

type Payload = Record<string, unknown> & { pets?: Array<Record<string, unknown>> };
type Submission = { id: string; payload: Payload; created_at: string; updated_at: string };
const initial: OnboardingActionState = { error: null, success: null };
const input = "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs";
const addressFields = [
  ["addressLine", "Jalan dan nomor rumah"], ["addressLine2", "Blok / unit"],
  ["recipientName", "Nama penerima"], ["recipientPhone", "Nomor penerima"],
  ["landmark", "Patokan"], ["postalCode", "Kode pos"],
  ["rt", "RT"], ["rw", "RW"], ["kelurahan", "Kelurahan / Desa"],
  ["accessNotes", "Catatan akses"],
] as const;

export function OnboardingReviewCard({ row, customers }: { row: Submission; customers: Array<{ id: string; name: string; phone: string | null }> }) {
  const [payload, setPayload] = useState<Payload>(row.payload);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveState, saveAction, saving] = useActionState(amendOnboardingAction, initial);
  const [reviewState, reviewAction, reviewing] = useActionState(reviewOnboardingAction, initial);
  const pets = Array.isArray(payload.pets) ? payload.pets : [];
  const phone = String(payload.phone ?? "");
  const duplicates = customers.filter((customer) => customer.phone?.replace(/\D/g, "") === phone.replace(/\D/g, ""));
  const patch = (key: string, value: string) => { setDirty(true); setPayload((current) => ({ ...current, [key]: value })); };
  const patchPet = (index: number, key: string, value: string) => { setDirty(true); setPayload((current) => ({ ...current, pets: (current.pets ?? []).map((pet, i) => i === index ? { ...pet, [key]: value, ...(key === "species" ? { breed: "", size: null } : {}) } : pet) })); };
  const referenceCount = pets.reduce((sum, pet) => sum + (Array.isArray(pet.styleReferences) ? pet.styleReferences.length : 0), 0);
  return <article className="rounded-2xl border border-slate-200 p-4">
    <div className="flex flex-wrap justify-between gap-3"><div><p className="font-bold">{String(payload.customerName ?? "Pelanggan")}</p><p className="text-xs text-slate-500">{phone} · {String(payload.kecamatan ?? "")}, {String(payload.kabupatenKota ?? "")} · {pets.length} pet{referenceCount ? ` · ${referenceCount} foto referensi` : ""}</p></div><span className="text-xs text-slate-400">{new Date(row.created_at).toLocaleString("id-ID")}</span></div>
    <div className="mt-3 flex flex-wrap gap-2">{pets.map((pet, index) => <span key={index} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{String(pet.name ?? "?")} · {String(pet.breed ?? pet.species ?? "")} · {String(pet.weightKg ?? "?")} kg</span>)}</div>
    {typeof payload.googleMapsUrl === "string" && isGoogleMapsLink(payload.googleMapsUrl) ? <a href={payload.googleMapsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-bold text-emerald-700 underline">Lihat link Google Maps dari pelanggan</a> : null}
    {duplicates.length ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">Nomor ini cocok dengan: {duplicates.map((d) => d.name).join(", ")}. Pilih pelanggan tersebut jika ingin menggabungkan.</p> : null}
    <button type="button" onClick={() => setEditing((value) => !value)} className="mt-4 rounded-lg border px-3 py-2 text-xs font-bold">{editing ? "Tutup editor" : "Periksa & ubah data sebelum setujui"}</button>
    {editing ? <form action={saveAction} className="mt-3 space-y-4 rounded-xl bg-slate-50 p-4">
      <input type="hidden" name="submissionId" value={row.id} /><input type="hidden" name="updatedAt" value={row.updated_at} /><input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold">Nama pemilik<input className={`${input} mt-1`} value={String(payload.customerName ?? "")} onChange={(e) => patch("customerName", e.target.value)} required /></label><label className="text-xs font-semibold">WhatsApp pemilik<input className={`${input} mt-1`} value={phone} onChange={(e) => patch("phone", e.target.value)} required /></label></div>
      <h3 className="text-xs font-bold uppercase text-slate-600">Alamat & penerima</h3>
      <div className="grid gap-2 sm:grid-cols-2">{addressFields.map(([key, label]) => <label key={key} className="text-xs font-semibold">{label}<input className={`${input} mt-1`} value={String(payload[key] ?? "")} onChange={(e) => patch(key, e.target.value)} /></label>)}</div>
      <label className="block text-xs font-semibold">Link Google Maps<input className={`${input} mt-1`} value={String(payload.googleMapsUrl ?? "")} onChange={(e) => patch("googleMapsUrl", e.target.value)} placeholder="https://maps.app.goo.gl/…" /></label>
      <IndonesiaRegionFields key={row.updated_at} initial={{ province: String(payload.province ?? ""), kabupatenKota: String(payload.kabupatenKota ?? ""), kecamatan: String(payload.kecamatan ?? "") }} onChange={(region) => { setDirty(true); setPayload((current) => ({ ...current, ...region })); }} className={input} />
      <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold">Latitude<input className={`${input} mt-1`} value={String(payload.latitude ?? "")} onChange={(e) => patch("latitude", e.target.value)} /></label><label className="text-xs font-semibold">Longitude<input className={`${input} mt-1`} value={String(payload.longitude ?? "")} onChange={(e) => patch("longitude", e.target.value)} /></label></div>
      <h3 className="text-xs font-bold uppercase text-slate-600">Pet</h3>
      {pets.map((pet, index) => <div key={String(pet.clientId ?? index)} className="grid gap-2 rounded-xl border bg-white p-3 sm:grid-cols-2"><label className="text-xs font-semibold">Nama<input className={`${input} mt-1`} value={String(pet.name ?? "")} onChange={(e) => patchPet(index, "name", e.target.value)} /></label><label className="text-xs font-semibold">Jenis<select className={`${input} mt-1`} value={String(pet.species ?? "dog")} onChange={(e) => patchPet(index, "species", e.target.value)}><option value="dog">Anjing</option><option value="cat">Kucing</option></select></label><BreedSelect species={pet.species === "cat" ? "cat" : "dog"} value={String(pet.breed ?? "")} onChange={(value) => patchPet(index, "breed", value)} className={input} label={`Ras pet ${index + 1}`} /><label className="text-xs font-semibold">Berat kg<input className={`${input} mt-1`} type="number" min="0.001" max="999" step="0.001" value={String(pet.weightKg ?? "")} onChange={(e) => patchPet(index, "weightKg", e.target.value)} /></label>{pets.length > 1 ? <button type="button" onClick={() => { setDirty(true); setPayload((current) => ({ ...current, pets: (current.pets ?? []).filter((_, i) => i !== index) })); }} className="text-left text-xs font-bold text-rose-700">Hapus pet ini</button> : null}</div>)}
      {pets.length < 5 ? <button type="button" onClick={() => { setDirty(true); setPayload((current) => ({ ...current, pets: [...(current.pets ?? []), { clientId: crypto.randomUUID(), name: "", species: "dog", breed: "", weightKg: "", styleReferences: [] }] })); }} className="rounded-lg border border-dashed px-3 py-2 text-xs font-bold text-emerald-700">+ Tambah pet</button> : null}
      {saveState.error || saveState.success ? <p className={`text-xs font-bold ${saveState.error ? "text-rose-700" : "text-emerald-700"}`}>{saveState.error ?? saveState.success}</p> : null}
      <button disabled={saving || !dirty} className="rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40">{saving ? "Menyimpan…" : "Simpan perbaikan"}</button>
    </form> : null}
    <form action={reviewAction} className="mt-4 flex flex-wrap gap-2"><input type="hidden" name="submissionId" value={row.id} /><select name="mergeCustomerId" className="h-10 rounded-xl border px-3 text-xs"><option value="">Buat pelanggan baru</option>{duplicates.map((d) => <option key={d.id} value={d.id}>Gabung ke {d.name}</option>)}</select><button disabled={reviewing || dirty} name="decision" value="approve" className="rounded-xl bg-emerald-700 px-4 text-xs font-bold text-white disabled:opacity-40">Setujui</button><button disabled={reviewing || dirty} name="decision" value="reject" className="rounded-xl border border-rose-200 px-4 text-xs font-bold text-rose-700 disabled:opacity-40">Tolak</button></form>
    {dirty ? <p className="mt-2 text-xs text-amber-700">Simpan perbaikan dahulu sebelum menyetujui atau menolak.</p> : null}
    {reviewState.error || reviewState.success ? <p className={`mt-2 text-xs font-bold ${reviewState.error ? "text-rose-700" : "text-emerald-700"}`}>{reviewState.error ?? reviewState.success}</p> : null}
  </article>;
}
