"use client";

/**
 * Function index:
 * - BlackoutManager: create, edit and soft-remove one-off availability blocks for a branch.
 *
 * Gated on `resource.manage`; the page does not render this panel without it, and every
 * action re-checks the capability server-side.
 *
 * Times are branch-local. The date and time inputs are separate for the same reason as the
 * reschedule form: a `datetime-local` value would be read as the visitor's wall clock.
 */
import { useActionState, useState } from "react";

import { ActionSubmitButton } from "@/components/action-submit-button";
import { createBlackoutAction, removeBlackoutAction, updateBlackoutAction } from "@/app/schedule/actions";
import { IDLE_STATE } from "@/lib/schedule/idle_state";
import type { ScheduleBlackout, ScheduleResource } from "@/lib/schedule";

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

export function BlackoutManager({
  branchId,
  timeZone,
  resources,
  blackouts,
  defaultDateISO,
}: {
  branchId: string;
  timeZone: string;
  resources: readonly ScheduleResource[];
  blackouts: readonly ScheduleBlackout[];
  defaultDateISO: string;
}) {
  const [createState, createAction] = useActionState(createBlackoutAction, IDLE_STATE);
  const [open, setOpen] = useState(false);
  const resourceNames = new Map(resources.map((resource) => [resource.id, resource.name]));

  // One blackout row can span several visible days; the loader emits one segment per day,
  // so de-duplicate by the underlying row id for the management list.
  const uniqueBlackouts = [...new Map(blackouts.map((blackout) => [blackout.id.split(":")[0], blackout])).values()];

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-800">Blokir ketersediaan</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">Tandai waktu ketika groomer tidak tersedia. Zona waktu cabang: {timeZone}.</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
        >
          {open ? "Tutup" : "Kelola blokir"}
        </button>
      </div>

      {open ? (
        <div className="mt-3 space-y-4">
          <form action={createAction} className="space-y-2 rounded-xl bg-slate-50 p-3">
            <input type="hidden" name="branchId" value={branchId} />
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Tambah blokir baru</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-500">Groomer</span>
                <select name="resourceId" required className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800">
                  <option value="">Pilih groomer</option>
                  {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-500">Tanggal</span>
                <input type="date" name="dateISO" defaultValue={defaultDateISO} required className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-500">Mulai</span>
                <input type="time" name="startTime" required className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-500">Selesai</span>
                <input type="time" name="endTime" required className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800" />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-slate-500">Alasan</span>
              <input type="text" name="reason" maxLength={500} placeholder="Cuti, libur mingguan, servis kendaraan…" className="h-10 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm text-slate-800" />
            </label>
            <Feedback error={createState.error} success={createState.success} />
            <ActionSubmitButton
              type="submit"
              pendingLabel="Menyimpan…"
              className="w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Tambah blokir
            </ActionSubmitButton>
          </form>

          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Blokir pada periode ini</p>
            {uniqueBlackouts.length === 0 ? <p className="text-[11px] text-slate-400">Belum ada blokir pada rentang tanggal yang ditampilkan.</p> : null}
            {uniqueBlackouts.map((blackout) => (
              <BlackoutRow
                key={blackout.id}
                blackout={blackout}
                branchId={branchId}
                resources={resources}
                resourceName={resourceNames.get(blackout.resourceId) ?? "Groomer"}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BlackoutRow({
  blackout,
  branchId,
  resources,
  resourceName,
}: {
  blackout: ScheduleBlackout;
  branchId: string;
  resources: readonly ScheduleResource[];
  resourceName: string;
}) {
  const [editState, editAction] = useActionState(updateBlackoutAction, IDLE_STATE);
  const [removeState, removeAction] = useActionState(removeBlackoutAction, IDLE_STATE);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rowId = blackout.id.split(":")[0];
  const segment = blackout.segments[0];

  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-bold text-slate-800">{resourceName} · {blackout.startLabel}–{blackout.endLabel}</p>
          <p className="truncate text-[11px] text-slate-400">{segment ? segment.dayISO : ""}{blackout.reason ? ` · ${blackout.reason}` : ""}</p>
        </div>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => { setEditing((p) => !p); setConfirming(false); }} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-50">
            {editing ? "Tutup" : "Ubah"}
          </button>
          <button type="button" onClick={() => { setConfirming((p) => !p); setEditing(false); }} className="rounded-lg border border-rose-200 px-2.5 py-1.5 text-[11px] font-bold text-rose-700 transition hover:bg-rose-50">
            Hapus
          </button>
        </div>
      </div>

      {editing ? (
        <form action={editAction} className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="branchId" value={branchId} />
          <input type="hidden" name="blackoutId" value={rowId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <select name="resourceId" defaultValue={blackout.resourceId} aria-label="Groomer" className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-800">
              {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
            </select>
            <input type="date" name="dateISO" defaultValue={segment?.dayISO ?? ""} required aria-label="Tanggal" className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-800" />
            <input type="time" name="startTime" defaultValue={blackout.startLabel} required aria-label="Mulai" className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-800" />
            <input type="time" name="endTime" defaultValue={blackout.endLabel === "24:00" ? "23:59" : blackout.endLabel} required aria-label="Selesai" className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-800" />
          </div>
          <input type="text" name="reason" defaultValue={blackout.reason ?? ""} maxLength={500} aria-label="Alasan" className="h-9 w-full rounded-xl border border-slate-200 bg-white px-2 text-xs text-slate-800" />
          <Feedback error={editState.error} success={editState.success} />
          <ActionSubmitButton type="submit" pendingLabel="Menyimpan…" className="w-full rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300">
            Simpan blokir
          </ActionSubmitButton>
        </form>
      ) : null}

      {confirming ? (
        <form action={removeAction} className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="branchId" value={branchId} />
          <input type="hidden" name="blackoutId" value={rowId} />
          <input type="hidden" name="confirm" value="yes" />
          <p className="text-[11px] font-semibold leading-4 text-rose-800">Hapus blokir ini? Baris tetap tersimpan untuk audit dan hanya hilang dari kalender.</p>
          <Feedback error={removeState.error} success={removeState.success} />
          <ActionSubmitButton type="submit" pendingLabel="Menghapus…" className="w-full rounded-xl bg-rose-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-300">
            Ya, hapus blokir
          </ActionSubmitButton>
        </form>
      ) : null}
    </div>
  );
}
