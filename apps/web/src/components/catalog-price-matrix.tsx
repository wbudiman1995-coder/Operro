"use client";

import { useActionState } from "react";
import { updateServiceAction, type PilotActionState } from "@/app/pilot-actions";
import type { CatalogWorkspace } from "@/lib/pilot-data";
import type { DogSizeBand } from "@/lib/pet-sizing";

const initial: PilotActionState = { error: null, success: null };
type Service = CatalogWorkspace["services"][number];
const legacy: Record<string, { suffix: string; price: keyof Service; duration: keyof Service }> = {
  extra_small: { suffix: "extraSmall", price: "priceExtraSmall", duration: "durationExtraSmall" },
  small: { suffix: "small", price: "priceSmall", duration: "durationSmall" },
  medium: { suffix: "medium", price: "priceMedium", duration: "durationMedium" },
  large: { suffix: "large", price: "priceLarge", duration: "durationLarge" },
  extra_large: { suffix: "extraLarge", price: "priceExtraLarge", duration: "durationExtraLarge" },
  cat: { suffix: "cat", price: "priceCat", duration: "durationCat" },
};

function MatrixRow({ service, dogSizeBands }: { service: Service; dogSizeBands: DogSizeBand[] }) {
  const [state, action, pending] = useActionState(updateServiceAction, initial);
  const zeroTime = service.duration === 0;
  const bands = [...dogSizeBands, { key: "cat", label: "Cat", upperKg: null }];
  return <tr className="border-t align-top"><th scope="row" className="sticky left-0 z-10 min-w-40 bg-white p-2 text-left text-xs"><span className="font-bold">{service.name}</span><span className="block font-normal text-slate-500">{zeroTime ? "Tanpa waktu tambahan" : `Dasar: ${service.duration} menit`}</span><input type="hidden" form={`matrix-${service.id}`} name="serviceId" value={service.id} /><input type="hidden" form={`matrix-${service.id}`} name="name" value={service.name} /><input type="hidden" form={`matrix-${service.id}`} name="category" value={service.category ?? ""} /><input type="hidden" form={`matrix-${service.id}`} name="duration" value={service.duration} /><input type="hidden" form={`matrix-${service.id}`} name="additionalDuration" value={service.additionalDuration} /><input type="hidden" form={`matrix-${service.id}`} name="price" value={service.price} />{zeroTime ? <input type="hidden" form={`matrix-${service.id}`} name="zeroTimeAddon" value="on" /> : null}{service.active ? <input type="hidden" form={`matrix-${service.id}`} name="isActive" value="on" /> : null}{service.fulfillmentModes.map((mode) => <input key={mode} type="hidden" form={`matrix-${service.id}`} name="fulfillmentModes" value={mode} />)}</th>
    {bands.map((band) => { const config = legacy[band.key]; const suffix = config?.suffix ?? `band_${band.key}`; const price = band.key === "cat" ? service.priceCat : service.dogSizePricing[band.key]?.price ?? (config ? service[config.price] as number | null : null); const duration = band.key === "cat" ? service.durationCat : service.dogSizePricing[band.key]?.duration ?? (config ? service[config.duration] as number | null : null); return <td key={band.key} className="min-w-28 p-2"><label className="text-[10px] text-slate-500">Rp<input form={`matrix-${service.id}`} type="number" name={`price_${suffix}`} min="0" step="1000" defaultValue={price ?? ""} aria-label={`${service.name} harga ${band.label}`} placeholder="harga dasar" className="mt-1 h-8 w-full rounded border px-2 text-xs" /></label><label className="mt-1 block text-[10px] text-slate-500">Menit<input form={`matrix-${service.id}`} type="number" name={`duration_${suffix}`} min="15" max="1440" step="5" defaultValue={duration ?? ""} disabled={zeroTime} aria-label={`${service.name} durasi ${band.label}`} placeholder={zeroTime ? "0" : "durasi dasar"} className="mt-1 h-8 w-full rounded border px-2 text-xs disabled:bg-slate-100" /></label></td>; })}
    <td className="min-w-28 p-2"><form id={`matrix-${service.id}`} action={action}><input type="hidden" name="speciesPricingJson" value={JSON.stringify(service.speciesPricing)} /><button disabled={pending} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan"}</button></form>{state.error || state.success ? <p className={`mt-2 text-[10px] ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}</td></tr>;
}

export function CatalogPriceMatrix({ services, dogSizeBands }: { services: Service[]; dogSizeBands: DogSizeBand[] }) {
  if (!services.length) return null;
  const categories = [...new Set(services.map((service) => service.category ?? "Tanpa kategori"))];
  return <section id="matriks-harga" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Ubah harga & durasi per ukuran</h2><p className="mt-1 text-xs text-slate-500">Pilih kategori, ubah angka langsung pada baris layanan, lalu tekan Simpan. Kosong berarti memakai harga atau durasi dasar. Perubahan berlaku untuk booking baru; invoice lama tetap memakai snapshot aslinya.</p>{categories.map((category) => <div key={category} className="mt-5"><h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">{category}</h3><div className="overflow-x-auto rounded-xl border"><table className="w-full min-w-[940px] border-collapse"><thead className="bg-slate-50"><tr><th className="sticky left-0 bg-slate-50 p-2 text-left text-xs">Layanan</th>{[...dogSizeBands, { key: "cat", label: "Cat", upperKg: null }].map((band) => <th key={band.key} className="p-2 text-left text-xs">{band.label}</th>)}<th className="p-2 text-left text-xs">Aksi</th></tr></thead><tbody>{services.filter((service) => (service.category ?? "Tanpa kategori") === category).map((service) => <MatrixRow key={service.id} service={service} dogSizeBands={dogSizeBands} />)}</tbody></table></div></div>)}</section>;
}
