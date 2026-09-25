"use client";

import { useState, useTransition } from "react";

import { issueInvoiceForBookingAction, previewInvoiceDiscountsAction, type InvoicePreview } from "@/app/pilot-actions";
import { INVOICE_DISCOUNT_CATEGORIES } from "@/lib/invoice-discount-categories";
import { formatRupiah } from "@/lib/pilot-data";

type DiscountType = "" | "percent" | "fixed";
interface Rule { type: DiscountType; value: string }
const EMPTY_RULE: Rule = { type: "", value: "" };

const field = "h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";

interface Pet { id: string; name: string }
interface ServiceLine { id: string; serviceId: string; name: string }

/** Section 22: lets staff configure invoice/pet/service/category discounts, preview the result, then issue. */
export function InvoiceDiscountPanel({ bookingId, pets, serviceLines, inInvoiceForm = false }: { bookingId: string; pets: Pet[]; serviceLines: ServiceLine[]; inInvoiceForm?: boolean }) {
  const [open, setOpen] = useState(false);
  const [invoiceRule, setInvoiceRule] = useState<Rule>(EMPTY_RULE);
  const [invoiceBasicOnly, setInvoiceBasicOnly] = useState(false);
  const [categoryRules, setCategoryRules] = useState<Record<string, Rule>>({});
  const [petRules, setPetRules] = useState<Record<string, Rule>>({});
  const [serviceRules, setServiceRules] = useState<Record<string, Rule>>({});
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const distinctServices = [...new Map(serviceLines.map((line) => [line.serviceId, line])).values()];

  function buildFormData() {
    const formData = new FormData();
    formData.set("bookingId", bookingId);
    if (invoiceRule.type && Number(invoiceRule.value) > 0) {
      formData.set("invoiceDiscountType", invoiceRule.type);
      formData.set("invoiceDiscountValue", invoiceRule.value);
      if (invoiceBasicOnly) formData.set("invoiceDiscountBasicOnly", "on");
    }
    for (const [slug] of INVOICE_DISCOUNT_CATEGORIES) {
      const rule = categoryRules[slug];
      if (rule?.type && Number(rule.value) > 0) { formData.set(`categoryDiscountType_${slug}`, rule.type); formData.set(`categoryDiscountValue_${slug}`, rule.value); }
    }
    for (const pet of pets) {
      const rule = petRules[pet.id];
      if (rule?.type && Number(rule.value) > 0) { formData.append("petDiscountId", pet.id); formData.append("petDiscountType", rule.type); formData.append("petDiscountValue", rule.value); }
    }
    for (const service of distinctServices) {
      const rule = serviceRules[service.serviceId];
      if (rule?.type && Number(rule.value) > 0) { formData.append("serviceDiscountId", service.serviceId); formData.append("serviceDiscountType", rule.type); formData.append("serviceDiscountValue", rule.value); }
    }
    return formData;
  }

  function runPreview() {
    setError(null);
    startTransition(async () => {
      const result = await previewInvoiceDiscountsAction(buildFormData());
      if (result.error) { setError(result.error); setPreview(null); } else setPreview(result.preview);
    });
  }

  if (!open) return <>{inInvoiceForm ? [...buildFormData().entries()].filter(([name]) => name !== "bookingId").map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" name={name} value={String(value)} />) : null}<button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700">Diskon &amp; biaya</button></>;

  return <div className="mt-3 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs">
    <div className="flex items-center justify-between"><p className="font-bold uppercase tracking-wide text-slate-500">Diskon invoice</p><button type="button" onClick={() => setOpen(false)} className="text-slate-500">Tutup</button></div>

    <div className="grid grid-cols-3 gap-2">
      <select className={field} value={invoiceRule.type} onChange={(event) => setInvoiceRule((rule) => ({ ...rule, type: event.target.value as DiscountType }))} aria-label="Jenis diskon invoice">
        <option value="">Tanpa diskon invoice</option><option value="percent">Persen (%)</option><option value="fixed">Nominal (Rp)</option>
      </select>
      <input className={field} type="number" min="0" step="1" placeholder="Nilai" value={invoiceRule.value} onChange={(event) => setInvoiceRule((rule) => ({ ...rule, value: event.target.value }))} aria-label="Nilai diskon invoice" />
      <label className="flex items-center gap-2"><input type="checkbox" checked={invoiceBasicOnly} onChange={(event) => setInvoiceBasicOnly(event.target.checked)} />Hanya Basic Grooming</label>
    </div>

    <div>
      <p className="mb-1 font-semibold text-slate-500">Per kategori</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {INVOICE_DISCOUNT_CATEGORIES.map(([slug, label]) => <div key={slug} className="grid grid-cols-2 gap-2">
          <select className={field} value={categoryRules[slug]?.type ?? ""} onChange={(event) => setCategoryRules((rules) => ({ ...rules, [slug]: { type: event.target.value as DiscountType, value: rules[slug]?.value ?? "" } }))} aria-label={`Jenis diskon ${label}`}>
            <option value="">{label}</option><option value="percent">{label} - %</option><option value="fixed">{label} - Rp</option>
          </select>
          <input className={field} type="number" min="0" step="1" placeholder="Nilai" value={categoryRules[slug]?.value ?? ""} onChange={(event) => setCategoryRules((rules) => ({ ...rules, [slug]: { type: rules[slug]?.type ?? "", value: event.target.value } }))} aria-label={`Nilai diskon ${label}`} />
        </div>)}
      </div>
    </div>

    {pets.length > 0 ? <div>
      <p className="mb-1 font-semibold text-slate-500">Per hewan</p>
      <div className="space-y-2">{pets.map((pet) => <div key={pet.id} className="grid grid-cols-3 items-center gap-2">
        <span className="truncate">{pet.name}</span>
        <select className={field} value={petRules[pet.id]?.type ?? ""} onChange={(event) => setPetRules((rules) => ({ ...rules, [pet.id]: { type: event.target.value as DiscountType, value: rules[pet.id]?.value ?? "" } }))} aria-label={`Jenis diskon ${pet.name}`}>
          <option value="">Tanpa diskon</option><option value="percent">%</option><option value="fixed">Rp</option>
        </select>
        <input className={field} type="number" min="0" step="1" placeholder="Nilai" value={petRules[pet.id]?.value ?? ""} onChange={(event) => setPetRules((rules) => ({ ...rules, [pet.id]: { type: rules[pet.id]?.type ?? "", value: event.target.value } }))} aria-label={`Nilai diskon ${pet.name}`} />
      </div>)}</div>
    </div> : null}

    {distinctServices.length > 0 ? <div>
      <p className="mb-1 font-semibold text-slate-500">Per layanan</p>
      <div className="space-y-2">{distinctServices.map((service) => <div key={service.serviceId} className="grid grid-cols-3 items-center gap-2">
        <span className="truncate">{service.name}</span>
        <select className={field} value={serviceRules[service.serviceId]?.type ?? ""} onChange={(event) => setServiceRules((rules) => ({ ...rules, [service.serviceId]: { type: event.target.value as DiscountType, value: rules[service.serviceId]?.value ?? "" } }))} aria-label={`Jenis diskon ${service.name}`}>
          <option value="">Tanpa diskon</option><option value="percent">%</option><option value="fixed">Rp</option>
        </select>
        <input className={field} type="number" min="0" step="1" placeholder="Nilai" value={serviceRules[service.serviceId]?.value ?? ""} onChange={(event) => setServiceRules((rules) => ({ ...rules, [service.serviceId]: { type: rules[service.serviceId]?.type ?? "", value: event.target.value } }))} aria-label={`Nilai diskon ${service.name}`} />
      </div>)}</div>
    </div> : null}

    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={runPreview} disabled={pending} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-50">{pending ? "Menghitung…" : "Pratinjau"}</button>
      {inInvoiceForm ? [...buildFormData().entries()].filter(([name]) => name !== "bookingId").map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" name={name} value={String(value)} />) : <form action={issueInvoiceForBookingAction}>
        {[...buildFormData().entries()].map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" name={name} value={String(value)} />)}
        <button className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white">Buat invoice</button>
      </form>}
    </div>

    {error ? <p className="font-semibold text-rose-700">{error}</p> : null}
    {preview ? <div className="space-y-1 rounded-xl border border-emerald-200 bg-white p-3">
      {preview.lines.map((line, index) => <div key={line.lineId ?? `fee-${index}`} className="flex items-center justify-between gap-2"><span className="truncate">{line.name} · {line.category}</span><span>{formatRupiah(line.gross)}{line.discountAmount > 0 ? <span className="text-rose-700"> -{formatRupiah(line.discountAmount)}</span> : null} = <strong>{formatRupiah(line.lineTotal)}</strong></span></div>)}
      {preview.transportFee > 0 ? <div className="flex items-center justify-between text-slate-600"><span>Biaya transportasi</span><span>{formatRupiah(preview.transportFee)}</span></div> : null}
      <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 font-bold"><span>Total setelah diskon</span><span>{formatRupiah(preview.total)} <span className="font-normal text-slate-500">(diskon {formatRupiah(preview.discountTotal)})</span></span></div>
    </div> : null}
  </div>;
}
