import regions from "@/data/indonesia-regions.json";

export interface RegionOption { code: string; name: string }
export interface RegionNames { province: string; kabupatenKota: string; kecamatan: string }

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");

/** Resolve user-supplied names to the exact bundled administrative hierarchy. */
export function canonicalRegionNames(value: RegionNames): RegionNames | null {
  const province = regions.provinces.find((item) => normalize(item.name) === normalize(value.province));
  if (!province) return null;
  const regency = (regions.regencies as Record<string, RegionOption[]>)[province.code]
    ?.find((item) => normalize(item.name) === normalize(value.kabupatenKota));
  if (!regency) return null;
  const district = (regions.districts as Record<string, RegionOption[]>)[regency.code]
    ?.find((item) => normalize(item.name) === normalize(value.kecamatan));
  return district ? { province: province.name, kabupatenKota: regency.name, kecamatan: district.name } : null;
}

export function districtsForRegency(regencyCode: string): RegionOption[] {
  if (!/^\d{2}\.\d{2}$/.test(regencyCode)) return [];
  return (regions.districts as Record<string, RegionOption[]>)[regencyCode] ?? [];
}
