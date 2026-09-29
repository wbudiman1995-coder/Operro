"use client";

import { useEffect, useId, useMemo, useState } from "react";
import lite from "@/data/indonesia-regions-lite.json";
import type { RegionNames, RegionOption } from "@/lib/indonesia-regions";

const empty: RegionNames = { province: "", kabupatenKota: "", kecamatan: "" };
const defaultClass = "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none focus:border-emerald-500";

function withLegacy(options: RegionOption[], name: string): RegionOption[] {
  if (!name || options.some((item) => item.name === name)) return options;
  return [{ code: "legacy", name }, ...options];
}

export function IndonesiaRegionFields({ initial, onChange, className = defaultClass }: {
  initial?: Partial<RegionNames>;
  onChange?: (value: RegionNames) => void;
  className?: string;
}) {
  const id = useId();
  const [value, setValue] = useState<RegionNames>({ ...empty, ...initial });
  const [districts, setDistricts] = useState<RegionOption[]>([]);
  const [districtError, setDistrictError] = useState(false);
  const province = lite.provinces.find((item) => item.name === value.province);
  const regencies = useMemo(() => province ? (lite.regencies as Record<string, RegionOption[]>)[province.code] ?? [] : [], [province]);
  const regency = regencies.find((item) => item.name === value.kabupatenKota);
  const regencyCode = regency?.code;

  useEffect(() => {
    if (!regencyCode) return;
    const controller = new AbortController();
    fetch(`/api/regions?regency=${encodeURIComponent(regencyCode)}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("regions_unavailable"); return response.json() as Promise<{ districts: RegionOption[] }> })
      .then((result) => { setDistricts(result.districts); setDistrictError(false); })
      .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === "AbortError")) setDistrictError(true); });
    return () => controller.abort();
  }, [regencyCode]);

  function update(next: RegionNames) { setValue(next); onChange?.(next); }
  const provinceOptions = withLegacy(lite.provinces, value.province);
  const regencyOptions = withLegacy(regencies, value.kabupatenKota);
  const districtOptions = withLegacy(districts, value.kecamatan);
  return <div className="grid gap-2.5 sm:grid-cols-3">
    <div><label htmlFor={`${id}-province`} className="text-[11px] font-semibold text-slate-500">Provinsi</label>
      <select id={`${id}-province`} className={className} value={value.province} onChange={(event) => { setDistricts([]); setDistrictError(false); update({ province: event.target.value, kabupatenKota: "", kecamatan: "" }); }}>
        <option value="">Pilih provinsi</option>{provinceOptions.map((item) => <option key={item.code} value={item.name}>{item.name}{item.code === "legacy" ? " (data lama)" : ""}</option>)}
      </select></div>
    <div><label htmlFor={`${id}-city`} className="text-[11px] font-semibold text-slate-500">Kabupaten/Kota</label>
      <select id={`${id}-city`} className={className} value={value.kabupatenKota} disabled={!value.province} onChange={(event) => { setDistricts([]); setDistrictError(false); update({ ...value, kabupatenKota: event.target.value, kecamatan: "" }); }}>
        <option value="">Pilih kabupaten/kota</option>{regencyOptions.map((item) => <option key={item.code} value={item.name}>{item.name}{item.code === "legacy" ? " (data lama)" : ""}</option>)}
      </select></div>
    <div><label htmlFor={`${id}-district`} className="text-[11px] font-semibold text-slate-500">Kecamatan</label>
      <select id={`${id}-district`} className={className} value={value.kecamatan} disabled={!value.kabupatenKota || districtError} onChange={(event) => update({ ...value, kecamatan: event.target.value })}>
        <option value="">{districtError ? "Daftar gagal dimuat" : "Pilih kecamatan"}</option>{districtOptions.map((item) => <option key={item.code} value={item.name}>{item.name}{item.code === "legacy" ? " (data lama)" : ""}</option>)}
      </select>{districtError ? <p className="mt-1 text-[11px] text-rose-600">Muat ulang halaman untuk memilih kecamatan.</p> : null}</div>
    <input type="hidden" name="province" value={value.province} />
    <input type="hidden" name="kabupatenKota" value={value.kabupatenKota} />
    <input type="hidden" name="kecamatan" value={value.kecamatan} />
  </div>;
}
