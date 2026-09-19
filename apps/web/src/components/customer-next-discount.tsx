"use client";

import { useActionState } from "react";

import { revokeCustomerNextDiscountAction, setCustomerNextDiscountAction, type PilotActionState } from "@/app/pilot-actions";

interface Offer { id: string; label: string; rules: Record<string, { type: string; value: number }>; expiresAt: string | null; note: string | null }
const initial: PilotActionState = { error: null, success: null };
const input = "h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm";

function Message({ state }: { state: PilotActionState }) {
  return state.error ? <p role="alert" className="text-xs font-semibold text-rose-700">{state.error}</p> : state.success ? <p className="text-xs font-semibold text-emerald-700">{state.success}</p> : null;
}

function Rule({ prefix, label }: { prefix: string; label: string }) {
  return <div className="rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="text-xs font-bold text-slate-700">{label}</p><div className="mt-2 grid grid-cols-[1fr_110px] gap-2"><select name={`${prefix}Type`} className={input}><option value="percent">Persen</option><option value="fixed">Nominal Rp</option></select><input name={`${prefix}Value`} className={input} type="number" min="0" step="0.01" placeholder="0" /></div></div>;
}

export function CustomerNextDiscount({ customerId, offer }: { customerId: string; offer: Offer | null }) {
  const [saveState, saveAction, saving] = useActionState(setCustomerNextDiscountAction, initial);
  const [revokeState, revokeAction, revoking] = useActionState(revokeCustomerNextDiscountAction, initial);
  return <section className="mt-5 rounded-2xl border border-violet-200 bg-violet-50/70 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-violet-600">Complimentary offer</p><h2 className="mt-1 font-bold text-violet-950">Diskon booking berikutnya</h2><p className="mt-1 text-xs leading-5 text-violet-700">Dipakai satu kali secara otomatis setelah booking baru berhasil dibuat. Booking lanjutan dalam seri tidak ikut menerima diskon.</p></div>{offer ? <span className="rounded-full bg-violet-600 px-3 py-1 text-[10px] font-bold uppercase text-white">Aktif</span> : null}</div>
    {offer ? <div className="mt-4 rounded-xl bg-white p-4 text-xs text-slate-700"><p className="font-bold text-slate-900">{offer.label}</p><p className="mt-1">{Object.entries(offer.rules).map(([scope, rule]) => `${scope.replaceAll("_", " ")}: ${rule.type === "percent" ? `${rule.value}%` : `Rp${rule.value.toLocaleString("id-ID")}`}`).join(" · ")}</p>{offer.expiresAt ? <p className="mt-1 text-slate-400">Berlaku sampai {new Date(offer.expiresAt).toLocaleDateString("id-ID")}</p> : null}{offer.note ? <p className="mt-2 text-slate-500">{offer.note}</p> : null}<form action={revokeAction} className="mt-3"><input type="hidden" name="customerId" value={customerId}/><input type="hidden" name="offerId" value={offer.id}/><button disabled={revoking} className="rounded-lg border border-rose-200 px-3 py-2 font-bold text-rose-700 disabled:opacity-50">{revoking ? "Mencabut…" : "Cabut penawaran"}</button></form><Message state={revokeState}/></div> : null}
    <details className="mt-4 rounded-xl border border-violet-200 bg-white"><summary className="cursor-pointer px-4 py-3 text-xs font-bold text-violet-800">{offer ? "Ganti aturan penawaran" : "+ Buat penawaran"}</summary><form action={saveAction} className="space-y-3 border-t border-violet-100 p-4"><input type="hidden" name="customerId" value={customerId}/><input name="label" maxLength={120} defaultValue="Complimentary next appointment" className={input} aria-label="Nama penawaran"/><div className="grid gap-2 lg:grid-cols-3"><Rule prefix="basic" label="Basic Grooming"/><Rule prefix="styling" label="Styling"/><Rule prefix="other" label="Layanan lain / add-on"/></div><div className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Berlaku sampai (opsional)<input name="expiresAt" type="date" className={`mt-1 ${input}`}/></label><label className="text-xs font-semibold text-slate-600">Catatan internal<input name="note" maxLength={500} className={`mt-1 ${input}`}/></label></div><Message state={saveState}/><button disabled={saving} className="rounded-xl bg-violet-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{saving ? "Menyimpan…" : "Aktifkan untuk booking berikutnya"}</button></form></details>
  </section>;
}
