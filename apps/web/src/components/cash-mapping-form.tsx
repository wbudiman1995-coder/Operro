"use client";

import { useActionState, useState } from "react";

import { setCashAccountMappingAction, type CashMappingActionState } from "@/app/finance/register/mapping/actions";
import { FLOW_LABELS, MAPPING_FLOWS, METHOD_LABELS, PAYMENT_METHODS, type MappingFlow } from "@/lib/cash-mapping";

const initial: CashMappingActionState = { error: null, success: null };
const input = "mt-1 block h-9 w-full rounded-lg border border-slate-200 px-2 text-xs";
const label = "text-[11px] font-semibold text-slate-500";

/** A fresh idempotency key per intended submission: it rotates after every success; a double click reuses the key. */
export function CashMappingForm({ accounts, branches, canMapOrgWide, initialKey, today }: {
  accounts: ReadonlyArray<{ id: string; name: string; currency: string; branchId: string | null }>;
  branches: ReadonlyArray<{ id: string; name: string }>;
  canMapOrgWide: boolean;
  initialKey: string;
  today: string;
}) {
  const [key, setKey] = useState(initialKey);
  const [flow, setFlow] = useState<MappingFlow>("payment");
  const [branchId, setBranchId] = useState(canMapOrgWide ? "" : branches[0]?.id ?? "");
  const [state, action, pending] = useActionState(async (previous: CashMappingActionState, formData: FormData) => {
    const result = await setCashAccountMappingAction(previous, formData);
    if (result.success) setKey(crypto.randomUUID());
    return result;
  }, initial);
  // An account tied to one branch only receives that branch's flows; an organization-wide rule only feeds an organization-wide account.
  const compatible = accounts.filter((account) => (branchId === "" ? account.branchId === null : account.branchId === null || account.branchId === branchId));
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Pemetaan kas">
      <input type="hidden" name="requestKey" value={key} />
      <label className={label}>Arus
        <select name="flow" value={flow} onChange={(event) => setFlow(event.target.value as MappingFlow)} className={input}>{MAPPING_FLOWS.map((value) => <option key={value} value={value}>{FLOW_LABELS[value]}</option>)}</select>
      </label>
      {flow === "payment"
        ? <label className={label}>Metode pembayaran<select name="method" className={input}>{PAYMENT_METHODS.map((value) => <option key={value} value={value}>{METHOD_LABELS[value]}</option>)}</select></label>
        : <input type="hidden" name="method" value="" />}
      <label className={label}>Berlaku untuk cabang
        <select name="branchId" value={branchId} onChange={(event) => setBranchId(event.target.value)} className={input}>
          {canMapOrgWide ? <option value="">Semua cabang</option> : null}
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
      <label className={label}>Akun tujuan
        <select name="accountId" className={input} defaultValue="">
          <option value="">Hentikan pemetaan (tidak ke akun mana pun)</option>
          {compatible.map((account) => <option key={account.id} value={account.id}>{account.name} ({account.currency})</option>)}
        </select>
      </label>
      <label className={label}>Berlaku mulai<input type="date" name="effectiveFrom" required defaultValue={today} min="2000-01-01" className={input} /></label>
      <div className="flex items-end"><button type="submit" disabled={pending} className="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan pemetaan"}</button></div>
      <p aria-live="polite" className="text-xs font-semibold sm:col-span-2 lg:col-span-3">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>
    </form>
  );
}
