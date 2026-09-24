"use client";

import { useActionState } from "react";

import { syncMissingAttendanceAction, waiveAttendanceLatenessAction, type PilotActionState } from "@/app/pilot-actions";

const initialState: PilotActionState = { error: null, success: null };

function Message({ state }: { state: PilotActionState }) {
  return state.error || state.success ? <p className={`text-[11px] font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null;
}

export function AttendanceSyncForm({ from, to }: { from: string; to: string }) {
  const [state, action, pending] = useActionState(syncMissingAttendanceAction, initialState);
  return <form action={action} className="flex flex-wrap items-center gap-2"><input type="hidden" name="from" value={from} /><input type="hidden" name="to" value={to} /><button disabled={pending} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyinkronkan…" : "Sinkronkan foto yang hilang"}</button><Message state={state} /></form>;
}

export function AttendanceWaiverForm({ attendanceId }: { attendanceId: string }) {
  const [state, action, pending] = useActionState(waiveAttendanceLatenessAction, initialState);
  return <form action={action} className="mt-2 flex flex-wrap gap-2"><input type="hidden" name="attendanceId" value={attendanceId} /><input name="reason" required minLength={3} className="h-8 min-w-40 flex-1 rounded-lg border border-amber-200 bg-white px-2 text-[11px]" placeholder="Alasan waiver" /><button disabled={pending} className="rounded-lg bg-amber-700 px-2.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Waive"}</button><Message state={state} /></form>;
}
