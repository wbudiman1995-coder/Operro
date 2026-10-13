"use client";

import { useActionState, useState } from "react";
import { updateServiceAction, type PilotActionState } from "@/app/pilot-actions";
import type { CatalogWorkspace } from "@/lib/pilot-data";
import { SpeciesPricingFields, type PetTypeOption } from "@/components/species-pricing-fields";
import { bandFieldNames, copyBandValues, pricingColumns, previousColumnKey, type BandColumn, type BandPrice, type SizeBandWorkspace } from "@/lib/size-bands";

const initial: PilotActionState = { error: null, success: null };
type Service = CatalogWorkspace["services"][number];
const bands = [
  ["extraSmall", "priceExtraSmall", "durationExtraSmall", "XS"],
  ["small", "priceSmall", "durationSmall", "S"],
  ["medium", "priceMedium", "durationMedium", "M"],
  ["large", "priceLarge", "durationLarge", "L"],
  ["extraLarge", "priceExtraLarge", "durationExtraLarge", "XL"],
  ["cat", "priceCat", "durationCat", "Cat"],
] as const;

function MatrixRow({ service, petTypes }: { service: Service; petTypes: PetTypeOption[] }) {
  const [state, action, pending] = useActionState(updateServiceAction, initial);
  const zeroTime = service.duration === 0;
  const formId = `matrix-${service.id}`;
  return <tr className="border-t align-top"><th scope="row" className="sticky left-0 z-10 min-w-52 bg-white p-2 text-left text-xs"><input form={formId} name="serviceId" type="hidden" value={service.id} /><label className="block text-[10px] text-slate-500">Layanan<input form={formId} name="name" defaultValue={service.name} required minLength={2} maxLength={100} className="mt-1 h-8 w-full rounded border px-2 text-xs font-bold text-slate-800" /></label><label className="mt-1 block text-[10px] text-slate-500">Kategori<input form={formId} name="category" defaultValue={service.category ?? ""} list="service-category-options" maxLength={40} placeholder="Tanpa kategori" className="mt-1 h-8 w-full rounded border px-2 text-xs" /></label><span className="mt-1 block font-normal text-slate-500">{zeroTime ? "Tanpa waktu tambahan" : `Dasar: ${service.duration} menit`}</span><input type="hidden" form={formId} name="duration" value={service.duration} /><input type="hidden" form={formId} name="additionalDuration" value={service.additionalDuration} /><input type="hidden" form={formId} name="price" value={service.price} />{zeroTime ? <input type="hidden" form={formId} name="zeroTimeAddon" value="on" /> : null}{service.fulfillmentModes.map((mode) => <input key={mode} type="hidden" form={formId} name="fulfillmentModes" value={mode} />)}<label className="mt-2 flex items-center gap-1 text-[10px] font-semibold text-slate-600"><input form={formId} type="checkbox" name="isActive" value="on" defaultChecked={service.active} />Aktif untuk booking baru</label><div className="mt-2 min-w-64"><SpeciesPricingFields petTypes={petTypes} initial={service.speciesPricing} zeroTime={zeroTime} formId={formId} /></div></th>
    {bands.map(([key, priceKey, durationKey, label]) => <td key={key} className="min-w-28 p-2"><label className="text-[10px] text-slate-500">Rp<input form={`matrix-${service.id}`} type="number" name={`price_${key}`} min="0" step="1000" defaultValue={service[priceKey] ?? ""} aria-label={`${service.name} harga ${label}`} placeholder="harga dasar" className="mt-1 h-8 w-full rounded border px-2 text-xs" /></label><label className="mt-1 block text-[10px] text-slate-500">Menit<input form={`matrix-${service.id}`} type="number" name={`duration_${key}`} min="15" max="1440" step="5" defaultValue={service[durationKey] ?? ""} disabled={zeroTime} aria-label={`${service.name} durasi ${label}`} placeholder={zeroTime ? "0" : "durasi dasar"} className="mt-1 h-8 w-full rounded border px-2 text-xs disabled:bg-slate-100" /></label></td>)}
    <td className="min-w-28 p-2"><form id={`matrix-${service.id}`} action={action}><button disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan"}</button></form>{state.error || state.success ? <p className={`mt-2 text-[10px] ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}</td></tr>;
}

type BandValues = Record<string, { price: string; duration: string }>;

/** Editable per-band values for one service in dynamic mode, with "copy from previous band". */
export function useBandValues(columns: readonly BandColumn[], stored: Record<string, BandPrice> | undefined) {
  const [values, setValues] = useState<BandValues>(() => Object.fromEntries(columns.map((column) => [column.key, { price: stored?.[column.key]?.price?.toString() ?? "", duration: stored?.[column.key]?.duration?.toString() ?? "" }])));
  const set = (key: string, part: "price" | "duration", value: string) => setValues((current) => ({ ...current, [key]: { ...current[key], [part]: value } }));
  const copy = (key: string) => setValues((current) => copyBandValues(current, columns, key));
  return { values, set, copy };
}

/** Dynamic-mode service row: one price/minutes pair per tenant band. Field names are band keys, never typed by the owner. */
function DynamicMatrixRow({ service, columns, stored, layoutVersion, petTypes }: { service: Service; columns: BandColumn[]; stored: Record<string, BandPrice> | undefined; layoutVersion: number; petTypes: PetTypeOption[] }) {
  const [state, action, pending] = useActionState(updateServiceAction, initial);
  const { values, set, copy } = useBandValues(columns, stored);
  const zeroTime = service.duration === 0;
  const formId = `matrix-${service.id}`;
  return <tr className="border-t align-top"><th scope="row" className="sticky left-0 z-10 min-w-52 bg-white p-2 text-left text-xs"><input form={formId} name="serviceId" type="hidden" value={service.id} /><label className="block text-[10px] text-slate-500">Layanan<input form={formId} name="name" defaultValue={service.name} required minLength={2} maxLength={100} className="mt-1 h-8 w-full rounded border px-2 text-xs font-bold text-slate-800" /></label><label className="mt-1 block text-[10px] text-slate-500">Kategori<input form={formId} name="category" defaultValue={service.category ?? ""} list="service-category-options" maxLength={40} placeholder="Tanpa kategori" className="mt-1 h-8 w-full rounded border px-2 text-xs" /></label><span className="mt-1 block font-normal text-slate-500">{zeroTime ? "Tanpa waktu tambahan" : `Dasar: ${service.duration} menit`} · {new Intl.NumberFormat("id-ID").format(service.price)}</span>
    <input type="hidden" form={formId} name="duration" value={service.duration} /><input type="hidden" form={formId} name="additionalDuration" value={service.additionalDuration} /><input type="hidden" form={formId} name="price" value={service.price} /><input type="hidden" form={formId} name="layoutVersion" value={layoutVersion} />{zeroTime ? <input type="hidden" form={formId} name="zeroTimeAddon" value="on" /> : null}{service.fulfillmentModes.map((mode) => <input key={mode} type="hidden" form={formId} name="fulfillmentModes" value={mode} />)}<label className="mt-2 flex items-center gap-1 text-[10px] font-semibold text-slate-600"><input form={formId} type="checkbox" name="isActive" value="on" defaultChecked={service.active} />Aktif untuk booking baru</label><div className="mt-2 min-w-64"><SpeciesPricingFields petTypes={petTypes} initial={service.speciesPricing} zeroTime={zeroTime} formId={formId} /></div></th>
    {columns.map((column) => { const names = bandFieldNames(column.key); const previous = previousColumnKey(columns, column.key); const previousLabel = columns.find((item) => item.key === previous)?.label;
      return <td key={column.key} className="min-w-28 p-2"><label className="text-[10px] text-slate-500">Rp<input form={formId} type="number" name={names.price} min="0" step="1000" value={values[column.key].price} onChange={(event) => set(column.key, "price", event.target.value)} aria-label={`${service.name} harga ${column.label}`} placeholder="harga dasar" className="mt-1 h-8 w-full rounded border px-2 text-xs" /></label><label className="mt-1 block text-[10px] text-slate-500">Menit<input form={formId} type="number" name={names.duration} min="15" max="1440" step="5" value={values[column.key].duration} onChange={(event) => set(column.key, "duration", event.target.value)} disabled={zeroTime} aria-label={`${service.name} durasi ${column.label}`} placeholder={zeroTime ? "0" : "durasi dasar"} className="mt-1 h-8 w-full rounded border px-2 text-xs disabled:bg-slate-100" /></label>
        {previous ? <button type="button" onClick={() => copy(column.key)} className="mt-1 text-[10px] font-bold text-emerald-800 underline" aria-label={`${service.name}: salin harga dan menit ${previousLabel} ke ${column.label}`}>Salin dari {previousLabel}</button> : null}</td>; })}
    <td className="min-w-28 p-2"><form id={formId} action={action}><button disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan"}</button></form>{state.error || state.success ? <p role={state.error ? "alert" : "status"} className={`mt-2 text-[10px] ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}</td></tr>;
}

export function CatalogPriceMatrix({ services, sizeBands, petTypes = [] }: { services: Service[]; sizeBands?: SizeBandWorkspace; petTypes?: PetTypeOption[] }) {
  if (!services.length) return null;
  const dynamic = sizeBands?.settings.mode === "dynamic";
  const columns: BandColumn[] = dynamic ? pricingColumns(sizeBands.bands) : [];
  const labels = dynamic ? columns.map((column) => column.label) : bands.map(([, , , label]) => label);
  const categories = [...new Set(services.map((service) => service.category ?? "Tanpa kategori"))];
  return <section id="matriks-harga" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><datalist id="service-category-options">{categories.filter((category) => category !== "Tanpa kategori").map((category) => <option key={category} value={category} />)}</datalist><h2 className="font-bold">Tabel layanan, harga & durasi</h2><p className="mt-1 text-xs text-slate-500">Ubah nama layanan, kategori, status, harga, dan menit langsung pada barisnya, lalu tekan Simpan. Kategori baru cukup diketik dan akan menjadi bagian baru setelah tersimpan. Kosong berarti memakai harga atau durasi dasar. Perubahan berlaku untuk booking baru; invoice lama tetap memakai snapshot aslinya.{dynamic ? " Kategori ukuran baru memakai harga dasar sampai Anda mengisi harganya; gunakan Salin dari kategori sebelumnya untuk mulai dari harga kategori di bawahnya." : ""}</p>{categories.map((category) => <div key={category} className="mt-5"><h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">{category}</h3><div className="overflow-x-auto rounded-xl border"><table className="w-full min-w-[940px] border-collapse"><thead className="bg-slate-50"><tr><th className="sticky left-0 bg-slate-50 p-2 text-left text-xs">Layanan</th>{labels.map((label) => <th key={label} className="p-2 text-left text-xs">{label}</th>)}<th className="p-2 text-left text-xs">Aksi</th></tr></thead><tbody>{services.filter((service) => (service.category ?? "Tanpa kategori") === category).map((service) => dynamic
      ? <DynamicMatrixRow key={`${service.id}:${sizeBands.settings.layoutVersion}`} service={service} columns={columns} stored={sizeBands.prices[service.id]} layoutVersion={sizeBands.settings.layoutVersion} petTypes={petTypes} />
      : <MatrixRow key={service.id} service={service} petTypes={petTypes} />)}</tbody></table></div></div>)}</section>;
}
