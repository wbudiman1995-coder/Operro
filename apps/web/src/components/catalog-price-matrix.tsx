"use client";

import { useActionState, useState } from "react";
import { updateServiceAction, type PilotActionState } from "@/app/pilot-actions";
import type { CatalogWorkspace } from "@/lib/pilot-data";
import { SpeciesPricingFields, type PetTypeOption } from "@/components/species-pricing-fields";
import { bandFieldNames, copyBandValues, pricingColumns, previousColumnKey, type BandColumn, type BandPrice, type SizeBandWorkspace } from "@/lib/size-bands";

const initial: PilotActionState = { error: null, success: null };
type Service = CatalogWorkspace["services"][number];
const bands = [
  ["extraSmall", "priceExtraSmall", "durationExtraSmall", "XS"], ["small", "priceSmall", "durationSmall", "S"], ["medium", "priceMedium", "durationMedium", "M"],
  ["large", "priceLarge", "durationLarge", "L"], ["extraLarge", "priceExtraLarge", "durationExtraLarge", "XL"], ["cat", "priceCat", "durationCat", "Cat"],
] as const;

function ServiceDetails({ service, petTypes, formId, layoutVersion }: { service: Service; petTypes: PetTypeOption[]; formId: string; layoutVersion?: number }) {
  const zeroTime = service.duration === 0;
  return <details className="mt-3 group">
    <summary className="cursor-pointer text-xs font-semibold text-emerald-800 underline underline-offset-2 marker:text-slate-400">Edit detail layanan & jenis pet tambahan</summary>
    <div className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-3">
      <label className="text-xs font-semibold text-slate-700">Nama layanan<input form={formId} name="name" defaultValue={service.name} required minLength={2} maxLength={100} className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-900" /></label>
      <label className="text-xs font-semibold text-slate-700">Kategori<input form={formId} name="category" defaultValue={service.category ?? ""} list="service-category-options" maxLength={40} placeholder="Tanpa kategori" className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
      <label className="flex items-center gap-2 self-end pb-2 text-xs font-semibold text-slate-700"><input form={formId} type="checkbox" name="isActive" value="on" defaultChecked={service.active} /> Tersedia untuk booking baru</label>
      <label className="text-xs font-semibold text-slate-700">Harga dasar<input form={formId} type="number" name="price" min="0" step="1000" defaultValue={service.price} className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
      <label className="text-xs font-semibold text-slate-700">Durasi dasar (menit)<input form={formId} type="number" name="duration" min="0" max="1440" step="5" defaultValue={service.duration} disabled={zeroTime} className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-100" /></label>
      <label className="text-xs font-semibold text-slate-700">Durasi tambahan (menit)<input form={formId} type="number" name="additionalDuration" min="0" max="1440" step="5" defaultValue={service.additionalDuration} disabled={zeroTime} className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-100" /></label>
      <div className="md:col-span-3"><SpeciesPricingFields petTypes={petTypes} initial={service.speciesPricing} zeroTime={zeroTime} formId={formId} /></div>
    </div>
    <input type="hidden" form={formId} name="serviceId" value={service.id} />
    {layoutVersion !== undefined ? <input type="hidden" form={formId} name="layoutVersion" value={layoutVersion} /> : null}
    {zeroTime ? <input type="hidden" form={formId} name="zeroTimeAddon" value="on" /> : null}
    {service.fulfillmentModes.map((mode) => <input key={mode} type="hidden" form={formId} name="fulfillmentModes" value={mode} />)}
  </details>;
}

function ServiceIdentity({ service, petTypes, formId, layoutVersion }: { service: Service; petTypes: PetTypeOption[]; formId: string; layoutVersion?: number }) {
  const zeroTime = service.duration === 0;
  return <th scope="row" className="sticky left-0 z-10 min-w-56 bg-white p-3 text-left">
    <p className="text-sm font-bold text-slate-900">{service.name}</p>
    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-medium">
      {service.category ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{service.category}</span> : null}
      <span className={`rounded-full px-2 py-0.5 ${service.active ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>{service.active ? "Aktif" : "Nonaktif"}</span>
    </div>
    <p className="mt-2 text-xs font-normal text-slate-500">{zeroTime ? "Tanpa waktu tambahan" : `Dasar: ${service.duration} menit`}</p>
    <ServiceDetails service={service} petTypes={petTypes} formId={formId} layoutVersion={layoutVersion} />
  </th>;
}

function MatrixRow({ service, petTypes }: { service: Service; petTypes: PetTypeOption[] }) {
  const [state, action, pending] = useActionState(updateServiceAction, initial);
  const zeroTime = service.duration === 0;
  const formId = `matrix-${service.id}`;
  return <tr className="border-t align-top">
    <ServiceIdentity service={service} petTypes={petTypes} formId={formId} />
    {bands.map(([key, priceKey, durationKey, label]) => <td key={key} className="min-w-28 p-3"><label className="text-xs font-medium text-slate-500">Harga (Rp)<input form={formId} type="number" name={`price_${key}`} min="0" step="1000" defaultValue={service[priceKey] ?? ""} aria-label={`${service.name} harga ${label}`} placeholder="Harga dasar" className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="mt-2 block text-xs font-medium text-slate-500">Menit<input form={formId} type="number" name={`duration_${key}`} min="15" max="1440" step="5" defaultValue={service[durationKey] ?? ""} disabled={zeroTime} aria-label={`${service.name} durasi ${label}`} placeholder={zeroTime ? "0" : "Durasi dasar"} className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2 text-sm disabled:bg-slate-100" /></label></td>)}
    <SaveCell formId={formId} action={action} pending={pending} state={state} />
  </tr>;
}

function SaveCell({ formId, action, pending, state }: { formId: string; action: (payload: FormData) => void; pending: boolean; state: PilotActionState }) {
  return <td className="min-w-28 p-3"><form id={formId} action={action}><button disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan"}</button></form>{state.error || state.success ? <p role={state.error ? "alert" : "status"} className={`mt-2 text-xs ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}</td>;
}

type BandValues = Record<string, { price: string; duration: string }>;
export function useBandValues(columns: readonly BandColumn[], stored: Record<string, BandPrice> | undefined) {
  const [values, setValues] = useState<BandValues>(() => Object.fromEntries(columns.map((column) => [column.key, { price: stored?.[column.key]?.price?.toString() ?? "", duration: stored?.[column.key]?.duration?.toString() ?? "" }])));
  const set = (key: string, part: "price" | "duration", value: string) => setValues((current) => ({ ...current, [key]: { ...current[key], [part]: value } }));
  const copy = (key: string) => setValues((current) => copyBandValues(current, columns, key));
  return { values, set, copy };
}

function DynamicMatrixRow({ service, columns, stored, layoutVersion, petTypes }: { service: Service; columns: BandColumn[]; stored: Record<string, BandPrice> | undefined; layoutVersion: number; petTypes: PetTypeOption[] }) {
  const [state, action, pending] = useActionState(updateServiceAction, initial);
  const { values, set, copy } = useBandValues(columns, stored);
  const zeroTime = service.duration === 0;
  const formId = `matrix-${service.id}`;
  return <tr className="border-t align-top">
    <ServiceIdentity service={service} petTypes={petTypes} formId={formId} layoutVersion={layoutVersion} />
    {columns.map((column) => { const names = bandFieldNames(column.key); const previous = previousColumnKey(columns, column.key); const previousLabel = columns.find((item) => item.key === previous)?.label; return <td key={column.key} className="min-w-28 p-3"><label className="text-xs font-medium text-slate-500">Harga (Rp)<input form={formId} type="number" name={names.price} min="0" step="1000" value={values[column.key].price} onChange={(event) => set(column.key, "price", event.target.value)} aria-label={`${service.name} harga ${column.label}`} placeholder="Harga dasar" className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="mt-2 block text-xs font-medium text-slate-500">Menit<input form={formId} type="number" name={names.duration} min="15" max="1440" step="5" value={values[column.key].duration} onChange={(event) => set(column.key, "duration", event.target.value)} disabled={zeroTime} aria-label={`${service.name} durasi ${column.label}`} placeholder={zeroTime ? "0" : "Durasi dasar"} className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2 text-sm disabled:bg-slate-100" /></label>{previous ? <button type="button" onClick={() => copy(column.key)} className="mt-2 text-xs font-bold text-emerald-800 underline underline-offset-2" aria-label={`${service.name}: salin harga dan menit ${previousLabel} ke ${column.label}`}>Salin dari {previousLabel}</button> : null}</td>; })}
    <SaveCell formId={formId} action={action} pending={pending} state={state} />
  </tr>;
}

export function CatalogPriceMatrix({ services, sizeBands, petTypes = [] }: { services: Service[]; sizeBands?: SizeBandWorkspace; petTypes?: PetTypeOption[] }) {
  if (!services.length) return null;
  const dynamic = sizeBands?.settings.mode === "dynamic";
  const columns: BandColumn[] = dynamic ? pricingColumns(sizeBands.bands) : [];
  const labels = dynamic ? columns.map((column) => column.label) : bands.map(([, , , label]) => label);
  const categories = [...new Set(services.map((service) => service.category ?? "Tanpa kategori"))];
  return <section id="matriks-harga" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><datalist id="service-category-options">{categories.filter((category) => category !== "Tanpa kategori").map((category) => <option key={category} value={category} />)}</datalist><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold text-slate-900">Harga & durasi per ukuran</h2><p className="mt-1 max-w-3xl text-sm text-slate-600">Isi harga dan menit per ukuran, lalu Simpan. Detail layanan dan jenis pet tambahan tersimpan rapi di dalam editor tiap layanan.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">Hanya untuk booking baru</span></div>{categories.map((category) => <div key={category} className="mt-6"><h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">{category}</h3><div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[1040px] border-collapse"><thead className="bg-slate-50"><tr><th className="sticky left-0 bg-slate-50 p-3 text-left text-xs font-bold text-slate-700">Layanan</th>{labels.map((label) => <th key={label} className="p-3 text-left text-xs font-bold text-slate-700">{label}</th>)}<th className="p-3 text-left text-xs font-bold text-slate-700">Aksi</th></tr></thead><tbody>{services.filter((service) => (service.category ?? "Tanpa kategori") === category).map((service) => dynamic ? <DynamicMatrixRow key={`${service.id}:${sizeBands.settings.layoutVersion}`} service={service} columns={columns} stored={sizeBands.prices[service.id]} layoutVersion={sizeBands.settings.layoutVersion} petTypes={petTypes} /> : <MatrixRow key={service.id} service={service} petTypes={petTypes} />)}</tbody></table></div></div>)}</section>;
}
