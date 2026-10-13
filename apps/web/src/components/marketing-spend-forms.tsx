"use client";

import { useActionState, useState } from "react";

import { recordMarketingSpendAction, reverseMarketingSpendAction, type MarketingSpendActionState } from "@/app/finance/marketing/actions";

const initial: MarketingSpendActionState = { error: null, success: null };
const input = "mt-1 block h-9 w-full rounded-lg border border-slate-200 px-2 text-xs";
const label = "text-[11px] font-semibold text-slate-500";

function Feedback({ state }: { state: MarketingSpendActionState }) {
  return <p aria-live="polite" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>;
}

/** A fresh idempotency key per intended submission: it rotates after every success; a double click reuses the key. */
function useKeyedAction(serverAction: (previous: MarketingSpendActionState, formData: FormData) => Promise<MarketingSpendActionState>, initialKey: string) {
  const [key, setKey] = useState(initialKey);
  const [state, action, pending] = useActionState(async (previous: MarketingSpendActionState, formData: FormData) => {
    const result = await serverAction(previous, formData);
    if (result.success) setKey(crypto.randomUUID());
    return result;
  }, initial);
  return { state, action, pending, key };
}

export function SpendForm({ initialKey, today, suggestions }: { initialKey: string; today: string; suggestions: readonly string[] }) {
  const { state, action, pending, key } = useKeyedAction(recordMarketingSpendAction, initialKey);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Catat biaya pemasaran">
      <input type="hidden" name="requestKey" value={key} />
      <label className={label}>Sumber
        <input name="source" required maxLength={80} list="spend-source-suggestions" className={input} placeholder="Instagram" />
        <datalist id="spend-source-suggestions">{suggestions.map((value) => <option key={value} value={value} />)}</datalist>
      </label>
      <label className={label}>Jumlah<input name="amount" required inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" placeholder="250000" className={input} /></label>
      <label className={label}>Mata uang<input name="currency" required defaultValue="IDR" minLength={3} maxLength={3} pattern="[A-Za-z]{3}" className={input} /></label>
      <label className={label}>Tanggal biaya<input type="date" name="spentOn" required defaultValue={today} max={today} min="2000-01-01" className={input} /></label>
      <label className={`${label} sm:col-span-2 lg:col-span-4`}>Catatan<input name="note" maxLength={200} className={input} placeholder="Opsional, misalnya iklan minggu 1" /></label>
      <div className="flex items-end"><button type="submit" disabled={pending} className="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Catat biaya"}</button></div>
      <div className="sm:col-span-2 lg:col-span-5"><Feedback state={state} /></div>
    </form>
  );
}

export function ReverseSpendForm({ entryId, initialKey }: { entryId: string; initialKey: string }) {
  const { state, action, pending, key } = useKeyedAction(reverseMarketingSpendAction, initialKey);
  return (
    <details className="text-left">
      <summary className="cursor-pointer text-[11px] font-bold text-rose-700">Balik</summary>
      <form action={action} className="mt-2 flex flex-wrap items-end gap-2" aria-label="Balik biaya pemasaran">
        <input type="hidden" name="entryId" value={entryId} />
        <input type="hidden" name="requestKey" value={key} />
        <label className={label}>Alasan<input name="reason" required minLength={3} maxLength={200} className={`${input} w-48`} /></label>
        <button type="submit" disabled={pending} className="h-9 rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-bold text-rose-800 disabled:opacity-60">{pending ? "…" : "Balik"}</button>
        <Feedback state={state} />
      </form>
    </details>
  );
}
