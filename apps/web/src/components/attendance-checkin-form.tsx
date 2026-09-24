"use client";

import { startTransition, useActionState, useState } from "react";

import { recordAttendanceCheckinAction, type PilotActionState } from "@/app/pilot-actions";
import { compressPhoto } from "@/lib/image-compression";

const initialState: PilotActionState = { error: null, success: null };

export function AttendanceCheckinForm({ bookingId, resourceId }: { bookingId: string; resourceId: string }) {
  const [state, action, pending] = useActionState(recordAttendanceCheckinAction, initialState);
  const [location, setLocation] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  function captureLocation() {
    if (!navigator.geolocation) { setLocationError("Perangkat ini tidak menyediakan GPS browser."); return; }
    setLocating(true); setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setLocation({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }); setLocating(false); },
      (error) => { setLocationError(error.message || "Lokasi tidak dapat dibaca. Izinkan akses lokasi lalu coba lagi."); setLocating(false); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!location) { setLocationError("Ambil lokasi GPS sebelum check-in."); return; }
    setPreparing(true);
    const data = new FormData(event.currentTarget);
    const original = data.get("photo");
    if (original instanceof File) data.set("photo", await compressPhoto(original));
    setPreparing(false);
    startTransition(() => action(data));
  }

  return <form action={action} onSubmit={submit} className="mt-3 rounded-xl border border-sky-100 bg-sky-50/70 p-3">
    <input type="hidden" name="bookingId" value={bookingId} /><input type="hidden" name="resourceId" value={resourceId} />
    <input type="hidden" name="latitude" value={location?.latitude ?? ""} /><input type="hidden" name="longitude" value={location?.longitude ?? ""} /><input type="hidden" name="accuracy" value={location?.accuracy ?? ""} />
    <p className="text-xs font-bold text-sky-950">Check-in kehadiran</p>
    <p className="mt-1 text-[11px] leading-4 text-sky-800">Foto, waktu server, dan GPS dicatat bersama. Keterlambatan dihitung dari jadwal booking.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
      <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="user" required className="min-w-0 rounded-lg border border-sky-200 bg-white p-2 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-sky-50 file:px-2 file:py-1 file:text-xs file:font-bold file:text-sky-800" />
      <button type="button" onClick={captureLocation} disabled={locating} className="rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs font-bold text-sky-800 disabled:opacity-50">{locating ? "Membaca GPS…" : location ? "Perbarui GPS" : "Ambil GPS"}</button>
    </div>
    {location ? <p className="mt-2 text-[11px] font-semibold text-emerald-700">GPS siap · akurasi ±{Math.round(location.accuracy)} m</p> : null}
    {locationError ? <p className="mt-2 text-[11px] font-semibold text-rose-700">{locationError}</p> : null}
    <input name="lateReason" className="mt-2 h-9 w-full rounded-lg border border-sky-200 bg-white px-3 text-xs" placeholder="Alasan bila terlambat (opsional)" />
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className={`text-[11px] font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p>
      <button disabled={pending || preparing || !location} className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{preparing ? "Menyiapkan foto…" : pending ? "Mencatat…" : "Check-in sekarang"}</button>
    </div>
  </form>;
}
