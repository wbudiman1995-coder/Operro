"use client";

/**
 * Function index:
 * - CustomerAddressForm: shared create/edit form for one saved address.
 * - CustomerAddressActions: "Jadikan utama" / "Hapus" buttons for one saved address.
 */
import { useActionState, useState } from "react";

import {
  createCustomerAddressAction,
  deleteCustomerAddressAction,
  setDefaultCustomerAddressAction,
  updateCustomerAddressAction,
  type PilotActionState,
} from "@/app/pilot-actions";
import type { CustomerAddress } from "@/lib/customer-360";
import { isSupportedShortMapsUrl, parseMapCoordinates } from "@/lib/maps";

const initialState: PilotActionState = { error: null, success: null };

const inputClass = "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
const labelClass = "text-[11px] font-semibold text-slate-500";
const buttonClass = "inline-flex h-10 items-center justify-center rounded-lg bg-emerald-700 px-4 text-xs font-bold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60";

function ActionMessage({ state }: { state: PilotActionState }) {
  if (!state.error && !state.success) return null;
  return <p className={`rounded-lg px-3 py-2 text-xs font-semibold ${state.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{state.error ?? state.success}</p>;
}

export function CustomerAddressForm({ customerId, existing }: { customerId: string; existing?: CustomerAddress }) {
  const action = existing ? updateCustomerAddressAction : createCustomerAddressAction;
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="space-y-2.5">
      <input type="hidden" name="customerId" value={customerId} />
      {existing ? <input type="hidden" name="addressId" value={existing.id} /> : null}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div><label className={labelClass}>Label</label><input className={inputClass} name="label" defaultValue={existing?.label ?? "Rumah"} placeholder="Rumah / Kantor" /></div>
        <div><label className={labelClass}>No. WhatsApp penerima</label><input className={inputClass} name="recipientPhone" defaultValue={existing?.recipientPhone ?? ""} placeholder="0812..." /></div>
      </div>
      <div><label className={labelClass}>Nama penerima</label><input className={inputClass} name="recipientName" defaultValue={existing?.recipientName ?? ""} /></div>
      <div><label className={labelClass}>Nama jalan dan nomor rumah</label><input className={inputClass} name="line1" defaultValue={existing?.line1 ?? ""} required /></div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div><label className={labelClass}>Detail tambahan</label><input className={inputClass} name="line2" defaultValue={existing?.line2 ?? ""} placeholder="Blok, unit" /></div>
        <div><label className={labelClass}>Patokan</label><input className={inputClass} name="landmark" defaultValue={existing?.landmark ?? ""} /></div>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-4">
        <div><label className={labelClass}>RT</label><input className={inputClass} name="rt" defaultValue={existing?.rt ?? ""} /></div>
        <div><label className={labelClass}>RW</label><input className={inputClass} name="rw" defaultValue={existing?.rw ?? ""} /></div>
        <div><label className={labelClass}>Kelurahan</label><input className={inputClass} name="kelurahan" defaultValue={existing?.kelurahan ?? ""} /></div>
        <div><label className={labelClass}>Kecamatan</label><input className={inputClass} name="kecamatan" defaultValue={existing?.kecamatan ?? ""} /></div>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <div><label className={labelClass}>Kabupaten/Kota</label><input className={inputClass} name="kabupatenKota" defaultValue={existing?.kabupatenKota ?? ""} /></div>
        <div><label className={labelClass}>Provinsi</label><input className={inputClass} name="province" defaultValue={existing?.province ?? ""} /></div>
        <div><label className={labelClass}>Kode pos</label><input className={inputClass} name="postalCode" defaultValue={existing?.postalCode ?? ""} /></div>
      </div>
      <div><label className={labelClass}>Catatan akses (pagar, parkir, keamanan)</label><textarea className={`${inputClass} h-auto py-2`} rows={2} name="accessNotes" defaultValue={existing?.accessNotes ?? ""} /></div>
      <MapsCoordinateFields initialLatitude={existing?.latitude} initialLongitude={existing?.longitude} />
      <div className="flex items-center justify-between gap-3 pt-1">
        <ActionMessage state={state} />
        <button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : existing ? "Simpan perubahan" : "Tambah alamat"}</button>
      </div>
    </form>
  );
}

export function MapsCoordinateFields({ initialLatitude, initialLongitude }: { initialLatitude?: number | null; initialLongitude?: number | null }) {
  const [mapsInput, setMapsInput] = useState("");
  const [latitude, setLatitude] = useState(initialLatitude?.toString() ?? "");
  const [longitude, setLongitude] = useState(initialLongitude?.toString() ?? "");
  const [mapsState, setMapsState] = useState<{ kind: "idle" | "loading" | "ok" | "error"; message: string }>({ kind: "idle", message: "" });

  async function readMapsLocation() {
    const direct = parseMapCoordinates(mapsInput);
    if (direct) {
      setLatitude(direct.latitude.toFixed(7));
      setLongitude(direct.longitude.toFixed(7));
      setMapsState({ kind: "ok", message: "Koordinat berhasil dibaca dari Google Maps." });
      return;
    }
    if (!isSupportedShortMapsUrl(mapsInput)) {
      setMapsState({ kind: "error", message: "Tempel full link, short link Google Maps, atau koordinat latitude, longitude." });
      return;
    }
    setMapsState({ kind: "loading", message: "Membuka short link Google Maps…" });
    try {
      const response = await fetch(`/api/maps/expand?url=${encodeURIComponent(mapsInput)}`);
      const result = await response.json() as { coordinates?: { latitude: number; longitude: number } | null; expandedUrl?: string; error?: string };
      if (!response.ok || !result.coordinates) throw new Error(result.error ?? "Koordinat tidak ditemukan dalam link ini.");
      setLatitude(result.coordinates.latitude.toFixed(7));
      setLongitude(result.coordinates.longitude.toFixed(7));
      if (result.expandedUrl) setMapsInput(result.expandedUrl);
      setMapsState({ kind: "ok", message: "Short link dibuka dan koordinat berhasil disimpan." });
    } catch (error) {
      setMapsState({ kind: "error", message: error instanceof Error ? error.message : "Link tidak dapat dibaca." });
    }
  }
  return <>
      <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
        <label className={labelClass}>Google Maps atau koordinat</label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input className={inputClass} value={mapsInput} onChange={(event) => { setMapsInput(event.target.value); setMapsState({ kind: "idle", message: "" }); }} placeholder="Tempel link Maps atau -6.1592, 106.9093" />
          <button type="button" onClick={readMapsLocation} disabled={!mapsInput.trim() || mapsState.kind === "loading"} className="h-10 shrink-0 rounded-lg border border-emerald-200 bg-white px-4 text-xs font-bold text-emerald-800 disabled:opacity-50">{mapsState.kind === "loading" ? "Membaca…" : "Ambil koordinat"}</button>
        </div>
        {mapsState.message ? <p className={`mt-2 text-[11px] font-semibold ${mapsState.kind === "error" ? "text-rose-700" : "text-emerald-700"}`}>{mapsState.message}</p> : <p className="mt-2 text-[11px] text-slate-500">Koordinat dipakai untuk rute, estimasi perjalanan, dan memastikan alamat home service lengkap.</p>}
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div><label className={labelClass}>Latitude</label><input className={inputClass} name="latitude" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="-6.1592" /></div>
        <div><label className={labelClass}>Longitude</label><input className={inputClass} name="longitude" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="106.9093" /></div>
      </div>
    </>;
}

export function CustomerAddressActions({ customerId, address }: { customerId: string; address: CustomerAddress }) {
  return (
    <div className="flex flex-wrap gap-2">
      {!address.isDefault ? (
        <form action={setDefaultCustomerAddressAction}>
          <input type="hidden" name="customerId" value={customerId} />
          <input type="hidden" name="addressId" value={address.id} />
          <button className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50">Jadikan utama</button>
        </form>
      ) : null}
      <form action={deleteCustomerAddressAction}>
        <input type="hidden" name="customerId" value={customerId} />
        <input type="hidden" name="addressId" value={address.id} />
        <button className="rounded-lg border border-rose-200 px-2.5 py-1.5 text-[11px] font-bold text-rose-600 hover:bg-rose-50">Hapus</button>
      </form>
    </div>
  );
}
