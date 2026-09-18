"use client";

import { useActionState, useMemo, useState } from "react";
import { replaceWeeklyAvailabilityAction } from "@/app/schedule/actions";
import { ActionSubmitButton } from "@/components/action-submit-button";
import { IDLE_STATE } from "@/lib/schedule/idle_state";
import type { ScheduleResource, WeeklyAvailability } from "@/lib/schedule";

const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
type DayWindow = { enabled: boolean; startTime: string; endTime: string };

export function WeeklyAvailabilityManager({ resources, availability, timeZone }: { resources: readonly ScheduleResource[]; availability: readonly WeeklyAvailability[]; timeZone: string }) {
  const [state, action] = useActionState(replaceWeeklyAvailabilityAction, IDLE_STATE);
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? "");
  const defaults = useMemo(() => buildDays(availability, resourceId), [availability, resourceId]);
  const [overrides, setOverrides] = useState<Record<string, DayWindow[]>>({});
  const days = overrides[resourceId] ?? defaults;
  const windows = days.flatMap((day, dayOfWeek) => day.enabled ? [{ dayOfWeek, startTime: day.startTime, endTime: day.endTime }] : []);

  function update(day: number, patch: Partial<DayWindow>) {
    setOverrides((current) => ({ ...current, [resourceId]: days.map((item, index) => index === day ? { ...item, ...patch } : item) }));
  }

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-sm font-bold text-slate-800">Jam kerja mingguan</h2><p className="mt-1 text-[11px] text-slate-400">Dipakai oleh pencarian slot. Zona waktu: {timeZone}.</p></div><label className="text-[11px] font-semibold text-slate-500">Groomer<select value={resourceId} onChange={(event) => setResourceId(event.target.value)} className="ml-2 h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs text-slate-800">{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label></div>
      {resourceId ? <form action={action} className="mt-4 space-y-2"><input type="hidden" name="resourceId" value={resourceId} /><input type="hidden" name="windows" value={JSON.stringify(windows)} />{days.map((day, index) => <div key={DAYS[index]} className="grid grid-cols-[88px_1fr_1fr] items-center gap-2 rounded-xl bg-slate-50 px-3 py-2"><label className="flex items-center gap-2 text-xs font-bold text-slate-700"><input type="checkbox" checked={day.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} className="accent-emerald-600" />{DAYS[index]}</label><input aria-label={`Mulai ${DAYS[index]}`} type="time" value={day.startTime} disabled={!day.enabled} onChange={(event) => update(index, { startTime: event.target.value })} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs disabled:opacity-40" /><input aria-label={`Selesai ${DAYS[index]}`} type="time" value={day.endTime} disabled={!day.enabled} onChange={(event) => update(index, { endTime: event.target.value })} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs disabled:opacity-40" /></div>)}{state.error || state.success ? <p role="status" className={`rounded-xl px-3 py-2 text-xs font-semibold ${state.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-800"}`}>{state.error ?? state.success}</p> : null}<ActionSubmitButton type="submit" pendingLabel="Menyimpan…" className="w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white disabled:bg-slate-300">Simpan jam kerja</ActionSubmitButton></form> : <p className="mt-4 text-xs text-slate-400">Belum ada groomer aktif.</p>}
    </section>
  );
}

function buildDays(availability: readonly WeeklyAvailability[], resourceId: string): DayWindow[] {
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const row = availability.find((item) => item.resourceId === resourceId && item.dayOfWeek === dayOfWeek);
    return { enabled: Boolean(row), startTime: row?.startTime ?? "08:00", endTime: row?.endTime ?? "17:00" };
  });
}
