"use client";

import { useActionState, useState } from "react";

import { updateFollowupRetentionSettingsAction } from "@/app/followups/actions";
import type { PilotActionState } from "@/app/pilot-actions";
import type { FollowupRetentionSettings } from "@/lib/followup-retention";
import { KNOWN_FOLLOWUP_PLACEHOLDERS, KNOWN_RENEWAL_PLACEHOLDERS } from "@/lib/followup-messages";

const initialState: PilotActionState = { error: null, success: null };

/** Section 35: compact, authorized settings panel embedded in /followups (no global Settings rewrite). */
export function FollowupSettingsPanel({ settings, canManage }: { settings: FollowupRetentionSettings; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const [threshold, setThreshold] = useState(String(settings.inactivityThresholdDays));
  const [followupTemplate, setFollowupTemplate] = useState(settings.followupTemplate);
  const [renewalTemplate, setRenewalTemplate] = useState(settings.renewalTemplate);
  const [state, formAction, pending] = useActionState(updateFollowupRetentionSettingsAction, initialState);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-bold text-slate-800">Ambang tidak aktif saat ini: {settings.inactivityThresholdDays} hari</p>
          <p className="mt-0.5 text-slate-500">Hewan dianggap overdue jika sudah {settings.inactivityThresholdDays} hari atau lebih sejak grooming terakhir.</p>
        </div>
        {canManage ? (
          <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-700">
            {open ? "Tutup pengaturan" : "Ubah pengaturan"}
          </button>
        ) : null}
      </div>

      {open && canManage ? (
        <form action={formAction} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <input type="hidden" name="expectedUpdatedAt" value={settings.updatedAt} />
          <label className="block">
            <span className="text-[11px] font-bold text-slate-600">Ambang tidak aktif (1-365 hari)</span>
            <input
              type="number" name="inactivityThresholdDays" min={1} max={365} step={1} required
              value={threshold} onChange={(event) => setThreshold(event.target.value)}
              className="mt-1 block h-9 w-32 rounded-lg border border-slate-200 px-2 text-xs"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-bold text-slate-600">Templat follow-up</span>
            <textarea
              name="followupTemplate" required rows={3} value={followupTemplate}
              onChange={(event) => setFollowupTemplate(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
            />
            <span className="mt-1 block text-[10px] text-slate-400">Placeholder yang didukung: {KNOWN_FOLLOWUP_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}</span>
          </label>
          <label className="block">
            <span className="text-[11px] font-bold text-slate-600">Templat perpanjangan</span>
            <textarea
              name="renewalTemplate" required rows={3} value={renewalTemplate}
              onChange={(event) => setRenewalTemplate(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
            />
            <span className="mt-1 block text-[10px] text-slate-400">Placeholder yang didukung: {KNOWN_RENEWAL_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}</span>
          </label>
          {state.error ? <p className="font-semibold text-rose-700">{state.error}</p> : null}
          {state.success ? <p className="font-semibold text-emerald-700">{state.success}</p> : null}
          <button disabled={pending} className="rounded-lg bg-slate-800 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50">
            {pending ? "Menyimpan…" : "Simpan pengaturan"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
