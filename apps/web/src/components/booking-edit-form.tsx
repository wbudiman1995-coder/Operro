"use client";

/**
 * Function index:
 * - BookingEditForm: explicit reschedule form — date, times, per-pet groomer, mode, notes.
 * - BookingCancelForm: two-step cancel with explicit confirmation.
 *
 * This drawer remains the detailed edit path for times, mode, notes and per-pet groomers.
 * The calendar also offers transactional drag/drop for a shared time offset; that path is
 * backed by one database RPC and does not use this compensated multi-step form.
 *
 * Times are plain `date` and `time` inputs rather than `datetime-local` because the value
 * must be interpreted in the BRANCH time zone on the server. A `datetime-local` value
 * carries no zone and reads as the visitor's local wall clock, which silently shifts the
 * booking for anyone not sitting in the branch's zone.
 *
 * Correction 3 (empty groomer submission): every pet's `<select>` is `required` and its
 * placeholder option is `disabled` — a browser cannot submit the form while a pet is left
 * on "Pilih groomer", and there is no plain empty `<option value="">` left for the
 * browser (or a scripted submit bypassing the UI) to silently carry through as "no
 * assignment". The server action re-validates the same rule; this is defense in depth,
 * not the only check.
 */
import { useActionState, useState } from "react";

import { ActionSubmitButton } from "@/components/action-submit-button";
import { cancelBookingAction, createBookingSeriesAction, rescheduleBookingAction } from "@/app/schedule/actions";
import { IDLE_STATE } from "@/lib/schedule/idle_state";
import { FULFILLMENT_MODES } from "@/lib/booking-mutations";
import type { BookingDetail, ScheduleResource } from "@/lib/schedule";

const MODE_LABELS: Record<string, string> = {
  home: "Ke rumah",
  in_store: "Di lokasi",
  pickup_delivery: "Antar-jemput",
};

function Feedback({ error, success }: { error: string | null; success: string | null }) {
  if (!error && !success) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`rounded-xl px-3 py-2 text-xs font-semibold leading-5 ${error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-800"}`}
    >
      {error ?? success}
    </p>
  );
}

export function BookingEditForm({
  detail,
  resources,
  timeZone,
}: {
  detail: BookingDetail;
  /** Active staff of the booking's own branch. The server re-validates every id. */
  resources: readonly ScheduleResource[];
  timeZone: string;
}) {
  const [state, action] = useActionState(rescheduleBookingAction, IDLE_STATE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800"
        >
          Ubah jadwal booking
        </button>
        <Feedback error={state.error} success={state.success} />
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
      <input type="hidden" name="bookingId" value={detail.id} />
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Ubah jadwal · zona {timeZone}</p>

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Tanggal</span>
          <input type="date" name="dateISO" defaultValue={detail.dateISO} required className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Mulai</span>
          <input type="time" name="startTime" defaultValue={detail.startTime} required className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Selesai</span>
          <input type="time" name="endTime" defaultValue={detail.endTime} required className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800" />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold text-slate-500">Metode layanan</span>
        <select name="fulfillmentMode" defaultValue={detail.fulfillmentMode} className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800">
          {FULFILLMENT_MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode] ?? mode}</option>)}
        </select>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-[11px] font-semibold text-slate-500">Groomer per hewan</legend>
        {detail.pets.length === 0 ? <p className="text-[11px] text-slate-400">Booking ini belum memiliki hewan.</p> : null}
        {detail.pets.map((pet) => (
          <label key={pet.jobPetId} className="flex items-center gap-2">
            <span className="w-24 shrink-0 truncate text-xs font-bold text-slate-700">{pet.petName}</span>
            <select
              name={`resource:${pet.jobPetId}`}
              defaultValue={pet.resourceId ?? ""}
              required
              aria-label={`Groomer untuk ${pet.petName}`}
              className="h-9 flex-1 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-800"
            >
              {/* Disabled placeholder, not a submittable empty option: every pet must
                  resolve to an explicit, currently-active branch groomer before the form
                  can be submitted (Correction 3). */}
              <option value="" disabled hidden>
                Pilih groomer…
              </option>
              {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
            </select>
          </label>
        ))}
        <p className="text-[10px] leading-4 text-slate-400">
          Setiap hewan wajib memiliki groomer aktif yang dipilih secara eksplisit. Layanan dan harga tidak berubah di sini.
        </p>
      </fieldset>

      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold text-slate-500">Catatan operasional</span>
        <textarea name="notes" defaultValue={detail.notes ?? ""} rows={3} maxLength={2000} className="w-full rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800" />
      </label>

      <Feedback error={state.error} success={state.success} />

      <div className="flex gap-2">
        <ActionSubmitButton
          type="submit"
          pendingLabel="Menyimpan…"
          className="flex-1 rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Simpan perubahan
        </ActionSubmitButton>
        <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50">
          Tutup
        </button>
      </div>
    </form>
  );
}

export function BookingCancelForm({ bookingId }: { bookingId: string }) {
  const [state, action] = useActionState(cancelBookingAction, IDLE_STATE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="w-full rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs font-bold text-rose-700 transition hover:bg-rose-100"
        >
          Batalkan booking
        </button>
        <Feedback error={state.error} success={state.success} />
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2 rounded-2xl border border-rose-200 bg-rose-50 p-3">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="confirm" value="yes" />
      <p className="text-xs font-semibold leading-5 text-rose-800">
        Batalkan booking ini? Sesi paket yang sedang ditahan akan dilepas dan slot groomer dibebaskan. Booking tidak dihapus, hanya berubah status.
      </p>
      <Feedback error={state.error} success={state.success} />
      <div className="flex gap-2">
        <ActionSubmitButton
          type="submit"
          pendingLabel="Membatalkan…"
          className="flex-1 rounded-xl bg-rose-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Ya, batalkan
        </ActionSubmitButton>
        <button type="button" onClick={() => setConfirming(false)} className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-bold text-rose-700">
          Kembali
        </button>
      </div>
    </form>
  );
}

export function BookingSeriesForm({ detail }: { detail: BookingDetail }) {
  const [state, action] = useActionState(createBookingSeriesAction, IDLE_STATE);
  const [open, setOpen] = useState(false);

  if (detail.seriesId) {
    return (
      <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
        <p className="font-bold">Booking rutin · urutan {detail.recurrenceSequence ?? "–"}</p>
        <p className="mt-1 text-[11px]">Perubahan seri dan pembatalan mendatang tetap tercatat melalui riwayat booking.</p>
      </div>
    );
  }
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="w-full rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5 text-xs font-bold text-violet-700 hover:bg-violet-100">Jadikan jadwal rutin</button>;
  }
  return (
    <form action={action} className="space-y-3 rounded-2xl border border-violet-200 bg-violet-50/70 p-3">
      <input type="hidden" name="bookingId" value={detail.id} />
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-violet-600">Buat seri dari booking ini</p>
      <label className="block"><span className="mb-1 block text-[11px] font-semibold text-slate-600">Frekuensi</span><select name="frequency" defaultValue="weekly" className="h-10 w-full rounded-xl border border-violet-200 bg-white px-2 text-sm"><option value="weekly">Setiap minggu</option><option value="biweekly">Setiap 2 minggu</option><option value="monthly">Setiap bulan</option></select></label>
      <label className="block"><span className="mb-1 block text-[11px] font-semibold text-slate-600">Jumlah booking termasuk booking ini</span><input name="occurrences" type="number" min={2} max={52} defaultValue={4} required className="h-10 w-full rounded-xl border border-violet-200 bg-white px-3 text-sm" /></label>
      <label className="block"><span className="mb-1 block text-[11px] font-semibold text-slate-600">Jika groomer bentrok</span><select name="conflictMode" defaultValue="skip" className="h-10 w-full rounded-xl border border-violet-200 bg-white px-2 text-sm"><option value="skip">Lewati tanggal yang bentrok</option><option value="stop">Batalkan seluruh pembuatan seri</option></select></label>
      <Feedback error={state.error} success={state.success} />
      <div className="flex gap-2"><ActionSubmitButton type="submit" pendingLabel="Membuat…" className="flex-1 rounded-xl bg-violet-600 px-3 py-2.5 text-xs font-bold text-white disabled:bg-slate-300">Buat seri</ActionSubmitButton><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-violet-200 bg-white px-3 py-2.5 text-xs font-bold text-violet-700">Batal</button></div>
    </form>
  );
}
