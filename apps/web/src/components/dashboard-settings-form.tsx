"use client";

import { useActionState, useState } from "react";

import { updateDashboardCardsAction, type DashboardCardSettingsState } from "@/app/dashboard/actions";
import { DASHBOARD_CARD_KEYS, DASHBOARD_CARD_LABELS, type DashboardCardVisibility } from "@/lib/dashboard-read-model";

const initialState: DashboardCardSettingsState = { error: null, success: null };

export function DashboardSettingsForm({ visibility, organizationId }: { visibility: DashboardCardVisibility; organizationId: string }) {
  const [state, action, pending] = useActionState(updateDashboardCardsAction.bind(null, organizationId), initialState);
  const [cards, setCards] = useState<DashboardCardVisibility>(visibility);

  return (
    <details className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-bold text-emerald-700">Pengaturan tampilan dashboard</summary>
      <form action={action} className="mt-3 space-y-2">
        <p className="text-xs text-slate-500">Pilih kartu yang tampil untuk seluruh anggota workspace. Data kartu tersembunyi tidak dimuat.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {DASHBOARD_CARD_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">
              <input type="checkbox" checked={cards[key]} onChange={(event) => setCards((current) => ({ ...current, [key]: event.target.checked }))} className="h-4 w-4" />
              <span>{DASHBOARD_CARD_LABELS[key]}</span>
              <input type="hidden" name={`card_${key}`} value={cards[key] ? "true" : "false"} />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <p aria-live="polite" className="text-xs font-semibold">
            {state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}
          </p>
          <button type="submit" disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">
            {pending ? "Menyimpan…" : "Simpan pengaturan"}
          </button>
        </div>
      </form>
    </details>
  );
}
