"use client";

import { useActionState, useState } from "react";
import { importCustomerHouseholdAction, type PilotActionState } from "@/app/pilot-actions";
import { parseBookingChat, type ParsedBookingChat } from "@/lib/booking-chat-parser";
import { isSupportedShortMapsUrl } from "@/lib/maps";

const initialState: PilotActionState = { error: null, success: null };
const inputClass = "h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";

export function FastCustomerImport() {
  const [state, action, pending] = useActionState(importCustomerHouseholdAction, initialState);
  const [sourceText, setSourceText] = useState("");
  const [parsed, setParsed] = useState<ParsedBookingChat | null>(null);
  const [parseMessage, setParseMessage] = useState("");

  async function parse() {
    if (!sourceText.trim()) { setParseMessage("Tempel chat booking terlebih dahulu."); return; }
    let next = parseBookingChat(sourceText);
    if (!next.latitude && isSupportedShortMapsUrl(next.mapsInput)) {
      try {
        const response = await fetch(`/api/maps/expand?url=${encodeURIComponent(next.mapsInput)}`);
        const result = await response.json() as { coordinates?: { latitude: number; longitude: number } | null };
        if (response.ok && result.coordinates) next = { ...next, ...result.coordinates };
      } catch { /* The preview remains usable and clearly flags missing coordinates. */ }
    }
    setParsed(next);
    setParseMessage(next.pets.length ? `${next.pets.length} hewan terdeteksi. Periksa hasil sebelum menyimpan.` : "Hewan belum terdeteksi. Pastikan ada baris Nama anabul: …");
  }
  function patch(patchValue: Partial<ParsedBookingChat>) { setParsed((current) => current ? { ...current, ...patchValue } : current); }
  function patchPet(index: number, patchValue: Partial<ParsedBookingChat["pets"][number]>) { setParsed((current) => current ? { ...current, pets: current.pets.map((pet, petIndex) => petIndex === index ? { ...pet, ...patchValue } : pet) } : current); }

  return <section className="rounded-3xl border border-[#b9e3d8] bg-[#f3fbf8] p-5 shadow-sm sm:p-7">
    <div><p className="text-xs font-bold uppercase tracking-[0.15em] text-emerald-700">Input cepat HomePaw</p><h2 className="mt-1 font-bold">Tempel chat booking</h2><p className="mt-1 text-xs leading-5 text-slate-600">Operro membaca owner, WhatsApp, alamat, Maps, dan beberapa hewan sekaligus. Data belum disimpan sampai Anda memeriksa lalu menekan tombol impor.</p></div>
    <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} rows={6} className="mt-4 w-full rounded-xl border border-emerald-200 bg-white p-3 text-xs leading-5 outline-none focus:ring-4 focus:ring-emerald-500/10" placeholder={'Nama Owner: …\nWhatsApp: …\nAlamat lengkap: …\nKota: …\nKecamatan: …\nGmaps link: …\nNama anabul: Milo dan Mochi\nBreed: Poodle dan Persian'} />
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-semibold text-emerald-800">{parseMessage}</p><button type="button" onClick={parse} className="h-10 rounded-xl border border-emerald-300 bg-white px-4 text-xs font-bold text-emerald-800">Isi otomatis & periksa</button></div>
    {parsed ? <form action={action} className="mt-5 space-y-4 border-t border-emerald-200 pt-5">
      <input type="hidden" name="household" value={JSON.stringify({ ...parsed, source: "Booking chat" })} />
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Nama owner<input className={`${inputClass} mt-1`} value={parsed.customerName} onChange={(event) => patch({ customerName: event.target.value })} /></label><label className="text-xs font-semibold text-slate-600">WhatsApp<input className={`${inputClass} mt-1`} value={parsed.phone} onChange={(event) => patch({ phone: event.target.value })} /></label></div>
      <label className="block text-xs font-semibold text-slate-600">Alamat lengkap<input className={`${inputClass} mt-1`} value={parsed.addressLine} onChange={(event) => patch({ addressLine: event.target.value })} /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Kabupaten/Kota<input className={`${inputClass} mt-1`} value={parsed.kabupatenKota} onChange={(event) => patch({ kabupatenKota: event.target.value })} /></label><label className="text-xs font-semibold text-slate-600">Kecamatan<input className={`${inputClass} mt-1`} value={parsed.kecamatan} onChange={(event) => patch({ kecamatan: event.target.value })} /></label></div>
      {parsed.mapsInput ? <p className={`rounded-xl px-3 py-2 text-xs font-semibold ${parsed.latitude !== null ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{parsed.latitude !== null ? `Koordinat Maps siap: ${parsed.latitude}, ${parsed.longitude}` : "Link Maps terbaca, tetapi koordinat belum ditemukan. Profil tetap dapat dibuat lalu lokasinya diperbaiki di Customer 360."}</p> : null}
      <div className="space-y-2"><p className="text-xs font-bold text-slate-700">Hewan ({parsed.pets.length})</p>{parsed.pets.map((pet, index) => <div key={`${index}-${pet.name}`} className="grid gap-2 rounded-xl border border-emerald-100 bg-white p-3 sm:grid-cols-[1fr_120px_1fr_100px]"><input aria-label={`Nama hewan ${index + 1}`} className={inputClass} value={pet.name} onChange={(event) => patchPet(index, { name: event.target.value })} placeholder="Nama" /><select aria-label={`Spesies ${pet.name}`} className={inputClass} value={pet.species} onChange={(event) => patchPet(index, { species: event.target.value === "cat" ? "cat" : "dog" })}><option value="dog">Anjing</option><option value="cat">Kucing</option></select><input aria-label={`Ras ${pet.name}`} className={inputClass} value={pet.breed} onChange={(event) => patchPet(index, { breed: event.target.value })} placeholder="Ras" /><input aria-label={`Berat ${pet.name}`} className={inputClass} type="number" min="0.1" step="0.1" value={pet.weightKg ?? ""} onChange={(event) => patchPet(index, { weightKg: event.target.value ? Number(event.target.value) : null })} placeholder="kg" /></div>)}</div>
      {state.error || state.success ? <p role="status" className={`rounded-xl px-3 py-2 text-xs font-semibold ${state.error ? "bg-rose-50 text-rose-700" : "bg-emerald-100 text-emerald-800"}`}>{state.error ?? state.success}</p> : null}
      <div className="flex justify-end"><button disabled={pending || parsed.customerName.trim().length < 2 || parsed.pets.length === 0 || parsed.pets.some((pet) => !pet.name.trim())} className="h-11 rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white disabled:opacity-50">{pending ? "Mengimpor…" : `Impor pelanggan + ${parsed.pets.length} hewan`}</button></div>
    </form> : null}
  </section>;
}
