"use client";

import { useActionState, useState } from "react";

import {
  createCashAccountAction, recordCashMovementAction, reverseCashMovementAction, setCashAccountArchivedAction,
  type CashRegisterActionState,
} from "@/app/finance/register/actions";
import { ACCOUNT_KIND_LABELS, ACCOUNT_KINDS, KIND_LABELS, MOVEMENT_KINDS, SOURCE_FOR_KIND, SOURCE_LABELS, type AccountPosition, type MovementKind } from "@/lib/cash-register";

const initial: CashRegisterActionState = { error: null, success: null };
const input = "mt-1 block h-9 w-full rounded-lg border border-slate-200 px-2 text-xs";
const label = "text-[11px] font-semibold text-slate-500";

function Feedback({ state }: { state: CashRegisterActionState }) {
  return <p aria-live="polite" className="text-xs font-semibold">{state.error ? <span className="text-rose-700">{state.error}</span> : state.success ? <span className="text-emerald-700">{state.success}</span> : null}</p>;
}

/**
 * A fresh idempotency key per intended submission: it rotates after every success, so the next entry is a new request,
 * while a double click or retry of the same entry reuses the key and cannot create a second movement.
 */
function useKeyedAction(serverAction: (previous: CashRegisterActionState, formData: FormData) => Promise<CashRegisterActionState>, initialKey: string) {
  const [key, setKey] = useState(initialKey);
  const [state, action, pending] = useActionState(async (previous: CashRegisterActionState, formData: FormData) => {
    const result = await serverAction(previous, formData);
    if (result.success) setKey(crypto.randomUUID());
    return result;
  }, initial);
  return { state, action, pending, key };
}

export function NewAccountForm({ branches, canCreateOrgWide }: { branches: ReadonlyArray<{ id: string; name: string }>; canCreateOrgWide: boolean }) {
  const [state, action, pending] = useActionState(createCashAccountAction, initial);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Akun kas baru">
      <label className={label}>Nama<input name="name" required maxLength={80} className={input} placeholder="Kas toko" /></label>
      <label className={label}>Jenis
        <select name="kind" className={input}>{ACCOUNT_KINDS.map((kind) => <option key={kind} value={kind}>{ACCOUNT_KIND_LABELS[kind]}</option>)}</select>
      </label>
      <label className={label}>Mata uang (tidak dapat diubah)<input name="currency" required defaultValue="IDR" minLength={3} maxLength={3} pattern="[A-Za-z]{3}" className={input} /></label>
      <label className={label}>Cabang (tidak dapat diubah)
        <select name="branchId" className={input} defaultValue={canCreateOrgWide ? "" : branches[0]?.id ?? ""}>
          {canCreateOrgWide ? <option value="">Semua cabang</option> : null}
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
      <div className="flex items-end"><button type="submit" disabled={pending} className="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Buat akun"}</button></div>
      <div className="sm:col-span-2 lg:col-span-5"><Feedback state={state} /></div>
    </form>
  );
}

export function MovementForm({ accounts, initialKey, today }: { accounts: readonly AccountPosition[]; initialKey: string; today: string }) {
  const { state, action, pending, key: requestKey } = useKeyedAction(recordCashMovementAction, initialKey);
  const [kind, setKind] = useState<MovementKind>("capital_contribution");
  const sourceTypes = SOURCE_FOR_KIND[kind] ?? [];
  const needsParty = kind === "capital_contribution" || kind === "owner_withdrawal";
  const active = accounts.filter((account) => account.status === "active");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Catat mutasi kas">
      <input type="hidden" name="requestKey" value={requestKey} />
      <label className={label}>Akun
        <select name="accountId" required className={input}>{active.map((account) => <option key={account.id} value={account.id}>{account.name} ({account.currency})</option>)}</select>
      </label>
      <label className={label}>Jenis mutasi
        <select name="kind" value={kind} onChange={(event) => setKind(event.target.value as MovementKind)} className={input}>{MOVEMENT_KINDS.map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}</select>
      </label>
      <label className={label}>Jumlah (mata uang akun)<input name="amount" required inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" placeholder="500000" className={input} /></label>
      <label className={label}>Tanggal<input type="date" name="occurredOn" required defaultValue={today} max={today} min="2000-01-01" className={input} /></label>
      {needsParty ? <label className={label}>{kind === "capital_contribution" ? "Dari (nama penyetor)" : "Untuk (nama penerima)"}<input name="counterparty" required maxLength={80} className={input} /></label> : <input type="hidden" name="counterparty" value="" />}
      <label className={`${label} sm:col-span-2`}>Catatan<input name="memo" maxLength={300} className={input} placeholder="Opsional" /></label>
      {sourceTypes.length > 0 ? <>
        <label className={label}>Tautan sumber (referensi, bukan posting)
          <select name="sourceType" className={input} defaultValue=""><option value="">Tanpa tautan</option>{sourceTypes.map((type) => <option key={type} value={type}>{SOURCE_LABELS[type]}</option>)}</select>
        </label>
        <label className={label}>ID sumber<input name="sourceId" className={input} placeholder="UUID pembayaran/pengeluaran/refund" /></label>
      </> : <><input type="hidden" name="sourceType" value="" /><input type="hidden" name="sourceId" value="" /></>}
      <div className="flex items-end"><button type="submit" disabled={pending || active.length === 0} className="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Catat mutasi"}</button></div>
      <div className="sm:col-span-2 lg:col-span-4"><Feedback state={state} /></div>
    </form>
  );
}

export function ReverseForm({ movementId, initialKey, today }: { movementId: string; initialKey: string; today: string }) {
  const { state, action, pending, key: requestKey } = useKeyedAction(reverseCashMovementAction, initialKey);
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer font-bold text-rose-700">Balik</summary>
      <form action={action} className="mt-2 flex flex-wrap items-end gap-2" aria-label="Balik mutasi">
        <input type="hidden" name="movementId" value={movementId} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <label className={label}>Alasan<input name="reason" required minLength={3} maxLength={300} className={`${input} w-48`} /></label>
        <label className={label}>Tanggal<input type="date" name="occurredOn" required defaultValue={today} max={today} className={`${input} w-36`} /></label>
        <button type="submit" disabled={pending} className="h-9 rounded-lg border border-rose-200 bg-rose-50 px-3 font-bold text-rose-700 disabled:opacity-60">{pending ? "…" : "Catat pembalikan"}</button>
        <Feedback state={state} />
      </form>
    </details>
  );
}

export function ArchiveButton({ account }: { account: AccountPosition }) {
  const [state, action, pending] = useActionState(setCashAccountArchivedAction, initial);
  const archive = account.status === "active";
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="accountId" value={account.id} />
      <input type="hidden" name="version" value={account.version} />
      <input type="hidden" name="archived" value={archive ? "true" : "false"} />
      <button type="submit" disabled={pending || (archive && account.balance !== 0)} title={archive && account.balance !== 0 ? "Saldo harus nol sebelum diarsipkan" : undefined}
        className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600 disabled:opacity-50">{archive ? "Arsipkan" : "Aktifkan"}</button>
      <Feedback state={state} />
    </form>
  );
}
