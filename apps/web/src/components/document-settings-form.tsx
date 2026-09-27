"use client";

import { useActionState } from "react";

import {
  deleteBankAccountAction,
  updateInvoiceDocumentSettingsAction,
  updateInvoiceLogoAction,
  upsertBankAccountAction,
  type DocumentSettingsActionState,
} from "@/app/document-settings-actions";

const initialState: DocumentSettingsActionState = { error: null, success: null };

export interface OrgBankAccount { id: string; bankName: string; accountNumber: string; accountHolder: string; isPrimary: boolean }
export interface DocumentSettings { tagline: string; membershipTerms: string; waPaidTemplate: string; waOutstandingTemplate: string; waSubscriptionTemplate: string }

const textareaClass = "w-full rounded-xl border border-slate-200 px-3 py-2 text-sm";
const inputClass = "h-10 w-full rounded-xl border border-slate-200 px-3 text-sm";

export function LogoSection({ logoUrl }: { logoUrl: string | null }) {
  const [state, action, pending] = useActionState(updateInvoiceLogoAction, initialState);
  return <div className="space-y-3">
    <div className="flex items-center gap-4">
      {logoUrl
        // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not a static asset next/image can optimize
        ? <img src={logoUrl} alt="Logo bisnis" className="h-16 w-16 rounded-xl border border-slate-200 object-contain bg-white" />
        : <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-dashed border-slate-300 text-[10px] font-semibold text-slate-400">Belum ada</div>}
      <form action={action} className="flex flex-1 items-center gap-2">
        <input type="hidden" name="intent" value="upload" />
        <input className="flex-1 text-xs" type="file" name="logo" accept="image/jpeg,image/png,image/webp" required />
        <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : logoUrl ? "Ganti" : "Unggah"}</button>
      </form>
      {logoUrl ? <RemoveLogoButton /> : null}
    </div>
    {state.error ? <p className="text-xs font-semibold text-rose-600">{state.error}</p> : state.success ? <p className="text-xs font-semibold text-emerald-700">{state.success}</p> : null}
  </div>;
}

function RemoveLogoButton() {
  const [state, action, pending] = useActionState(updateInvoiceLogoAction, initialState);
  return <form action={action}>
    <input type="hidden" name="intent" value="remove" />
    <button className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-bold text-rose-700 disabled:opacity-60" disabled={pending}>{pending ? "..." : "Hapus"}</button>
    {state.error ? <p className="mt-1 text-[10px] font-semibold text-rose-600">{state.error}</p> : null}
  </form>;
}

export function DocumentSettingsForm({ settings }: { settings: DocumentSettings }) {
  const [state, action, pending] = useActionState(updateInvoiceDocumentSettingsAction, initialState);
  return <form action={action} className="space-y-3">
    <label className="block text-xs font-bold text-slate-600">Tagline bisnis (tampil di dokumen)</label>
    <input className={inputClass} name="tagline" defaultValue={settings.tagline} placeholder="Contoh: Perawatan hewan tepercaya sejak 2020" />

    <label className="block text-xs font-bold text-slate-600">Syarat & ketentuan membership/langganan</label>
    <textarea className={textareaClass} name="membershipTerms" defaultValue={settings.membershipTerms} rows={4} placeholder="Ditampilkan pada invoice paket/langganan." />

    <label className="block text-xs font-bold text-slate-600">Template WhatsApp — pelunasan/prepaid selesai</label>
    <textarea className={textareaClass} name="waPaidTemplate" defaultValue={settings.waPaidTemplate} rows={2} placeholder="Halo {customer}, invoice {number} sudah lunas. Terima kasih!" />

    <label className="block text-xs font-bold text-slate-600">Template WhatsApp — invoice belum lunas</label>
    <textarea className={textareaClass} name="waOutstandingTemplate" defaultValue={settings.waOutstandingTemplate} rows={2} placeholder="Halo {customer}, invoice {number} sebesar {total} belum lunas." />

    <label className="block text-xs font-bold text-slate-600">Template WhatsApp — tagihan langganan/paket</label>
    <textarea className={textareaClass} name="waSubscriptionTemplate" defaultValue={settings.waSubscriptionTemplate} rows={2} placeholder="Halo {customer}, tagihan langganan {number} sebesar {total}." />

    <p className="text-[11px] text-slate-500">Placeholder yang tersedia: {"{customer}"}, {"{number}"}, {"{total}"}.</p>
    <div className="flex items-center justify-between gap-3">
      {state.error ? <p className="text-xs font-semibold text-rose-600">{state.error}</p> : state.success ? <p className="text-xs font-semibold text-emerald-700">{state.success}</p> : <span />}
      <button className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Menyimpan..." : "Simpan pengaturan dokumen"}</button>
    </div>
  </form>;
}

function BankAccountRow({ account }: { account: OrgBankAccount }) {
  const [state, action, pending] = useActionState(deleteBankAccountAction, initialState);
  return <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
    <div>
      <p className="text-sm font-bold">{account.bankName} {account.isPrimary ? <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">Utama</span> : null}</p>
      <p className="text-xs text-slate-500">{account.accountNumber} — a.n. {account.accountHolder}</p>
    </div>
    <form action={action}>
      <input type="hidden" name="id" value={account.id} />
      <button className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-bold text-rose-700 disabled:opacity-60" disabled={pending}>{pending ? "..." : "Hapus"}</button>
      {state.error ? <p className="mt-1 text-[10px] font-semibold text-rose-600">{state.error}</p> : null}
    </form>
  </div>;
}

function AddBankAccountForm({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState(upsertBankAccountAction, initialState);
  if (disabled) return <p className="text-xs text-slate-500">Maksimum 2 rekening bank sudah tercapai. Hapus salah satu untuk menambah yang baru.</p>;
  return <form action={action} className="grid gap-2 sm:grid-cols-4">
    <input className={inputClass} name="bankName" placeholder="Nama bank" required />
    <input className={inputClass} name="accountNumber" placeholder="Nomor rekening" required />
    <input className={inputClass} name="accountHolder" placeholder="Atas nama" required />
    <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" name="isPrimary" value="true" /> Jadikan utama</label>
    <div className="sm:col-span-4 flex items-center justify-between gap-3">
      {state.error ? <p className="text-xs font-semibold text-rose-600">{state.error}</p> : null}
      <button className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Menyimpan..." : "Tambah rekening"}</button>
    </div>
  </form>;
}

export function BankAccountsSection({ accounts }: { accounts: OrgBankAccount[] }) {
  return <div className="space-y-3">
    {accounts.map((a) => <BankAccountRow key={a.id} account={a} />)}
    <AddBankAccountForm disabled={accounts.length >= 2} />
  </div>;
}
