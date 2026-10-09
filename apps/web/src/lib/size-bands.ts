/**
 * Presentation helpers for tenant-owned dog size bands (Bundle 2).
 *
 * SQL is the sole authority for authorization, key generation, layout
 * validation, prices, durations, dependency checks and impact calculation.
 * Everything here is display-only: it shapes data for forms, formats ranges,
 * gives early feedback on a draft and translates database error codes. Nothing
 * in this file decides what a pet or service costs.
 */

export type SizeBandKind = "dog_weight" | "cat";
export type SizeBandMode = "legacy" | "dynamic";

export interface SizeBand {
  id: string;
  key: string;
  kind: SizeBandKind;
  label: string;
  sortOrder: number;
  upperKg: number | null;
  upperInclusive: boolean;
  status: "active" | "archived";
}

export interface SizeBandSettings { mode: SizeBandMode; layoutVersion: number }
export interface BandPrice { price: number | null; duration: number | null }
/** service id -> band key -> stored price/duration row (dynamic mode only). */
export type BandPriceMap = Record<string, Record<string, BandPrice>>;

export interface SizeBandWorkspace {
  settings: SizeBandSettings;
  bands: SizeBand[];
  prices: BandPriceMap;
}

export interface BandColumn { key: string; label: string; kind: SizeBandKind }

/** Legacy layout shown before any band row is loaded (keys are the historical ones). */
export const LEGACY_BAND_COLUMNS: BandColumn[] = [
  { key: "extra_small", label: "XS", kind: "dog_weight" },
  { key: "small", label: "S", kind: "dog_weight" },
  { key: "medium", label: "M", kind: "dog_weight" },
  { key: "large", label: "L", kind: "dog_weight" },
  { key: "extra_large", label: "XL", kind: "dog_weight" },
  { key: "cat", label: "Cat", kind: "cat" },
];

export function activeDogBands(bands: readonly SizeBand[]): SizeBand[] {
  return bands.filter((band) => band.kind === "dog_weight" && band.status === "active").sort((a, b) => a.sortOrder - b.sortOrder);
}

export function archivedDogBands(bands: readonly SizeBand[]): SizeBand[] {
  return bands.filter((band) => band.kind === "dog_weight" && band.status === "archived").sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Matrix/option columns: active dog bands in weight order, then the permanent Cat band. */
export function pricingColumns(bands: readonly SizeBand[]): BandColumn[] {
  const dogs = activeDogBands(bands).map((band) => ({ key: band.key, label: band.label, kind: band.kind }));
  const cat = bands.find((band) => band.kind === "cat" && band.status === "active");
  return [...dogs, ...(cat ? [{ key: cat.key, label: cat.label, kind: cat.kind } as BandColumn] : [])];
}

/** Options for the package size select (exact band matching; no "larger covers smaller"). */
export function packageSizeOptions(bands: readonly SizeBand[]): Array<{ value: string; label: string }> {
  return pricingColumns(bands).map((column) => ({ value: column.key, label: column.label }));
}

export function bandLabel(bands: readonly SizeBand[], key: string | null | undefined): string {
  if (!key) return "";
  return bands.find((band) => band.key === key)?.label ?? LEGACY_BAND_COLUMNS.find((column) => column.key === key)?.label ?? key;
}

function kg(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** Human range text derived from the contiguous partition, e.g. "< 5 kg", "≥ 5 – < 10 kg", "> 25 kg". */
export function rangeLabel(bands: readonly SizeBand[], key: string): string {
  const dogs = activeDogBands(bands);
  const index = dogs.findIndex((band) => band.key === key);
  if (index < 0) return key === "cat" ? "Kucing (terpisah)" : "Diarsipkan";
  const band = dogs[index];
  const previous = index > 0 ? dogs[index - 1] : null;
  const lower = previous && previous.upperKg !== null ? `${previous.upperInclusive ? ">" : "≥"} ${kg(previous.upperKg)}` : null;
  const upper = band.upperKg !== null ? `${band.upperInclusive ? "≤" : "<"} ${kg(band.upperKg)}` : null;
  if (lower && upper) return `${lower} – ${upper} kg`;
  if (lower) return `${lower} kg`;
  if (upper) return `${upper} kg`;
  return "semua berat";
}

// ---------------------------------------------------------------- layout draft

export interface LayoutDraftRow { id: string | null; label: string; upper: string; inclusive: boolean }
export interface LayoutPayloadBand { id?: string; label: string; upper_kg: number | null; upper_inclusive: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Early request-shape validation for the catalog actions; SQL remains authoritative. */
export function isValidLayoutPayload(bands: unknown): bands is LayoutPayloadBand[] {
  return Array.isArray(bands) && bands.length >= 1 && bands.length <= 12 && bands.every((band) => {
    if (!band || typeof band !== "object") return false;
    const item = band as Record<string, unknown>;
    return typeof item.label === "string" && item.label.trim().length >= 1 && item.label.trim().length <= 40
      && (item.upper_kg === null || (typeof item.upper_kg === "number" && Number.isFinite(item.upper_kg)))
      && typeof item.upper_inclusive === "boolean"
      && (item.id === undefined || (typeof item.id === "string" && UUID.test(item.id)));
  });
}

export function draftFromBands(bands: readonly SizeBand[]): LayoutDraftRow[] {
  return activeDogBands(bands).map((band) => ({ id: band.id, label: band.label, upper: band.upperKg === null ? "" : kg(band.upperKg), inclusive: band.upperInclusive }));
}

export function draftToPayload(rows: readonly LayoutDraftRow[]): LayoutPayloadBand[] {
  return rows.map((row, index) => {
    const last = index === rows.length - 1;
    return {
      ...(row.id ? { id: row.id } : {}),
      label: row.label.trim(),
      upper_kg: last ? null : Number(row.upper),
      upper_inclusive: last ? false : row.inclusive,
    };
  });
}

export type LayoutIssueCode = "count" | "label" | "duplicate_label" | "upper" | "order" | "decimals";
export interface LayoutIssue { code: LayoutIssueCode; row: number | null }

export const MAX_ACTIVE_DOG_BANDS = 12;

/** Early, advisory feedback only. The database validates the same rules again and refuses invalid layouts. */
export function validateLayoutDraft(rows: readonly LayoutDraftRow[]): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  if (rows.length < 1 || rows.length > MAX_ACTIVE_DOG_BANDS) issues.push({ code: "count", row: null });
  const seen = new Set<string>();
  let previous: number | null = null;
  rows.forEach((row, index) => {
    const label = row.label.trim();
    if (label.length < 1 || label.length > 40) issues.push({ code: "label", row: index });
    else if (seen.has(label.toLowerCase())) issues.push({ code: "duplicate_label", row: index });
    seen.add(label.toLowerCase());
    if (index === rows.length - 1) return;
    const text = row.upper.trim();
    const value = Number(text);
    if (!text || !Number.isFinite(value) || value <= 0 || value > 999) { issues.push({ code: "upper", row: index }); return; }
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) { issues.push({ code: "decimals", row: index }); return; }
    if (previous !== null && value <= previous) issues.push({ code: "order", row: index });
    previous = value;
  });
  return issues;
}

export const LAYOUT_ISSUE_TEXT: Record<LayoutIssueCode, string> = {
  count: "Jumlah kategori harus 1 sampai 12.",
  label: "Nama kategori wajib diisi (maksimal 40 karakter).",
  duplicate_label: "Nama kategori tidak boleh kembar.",
  upper: "Batas atas harus angka lebih dari 0 dan maksimal 999 kg.",
  order: "Batas atas harus makin besar dari kategori sebelumnya.",
  decimals: "Batas atas maksimal dua angka di belakang koma.",
};

/** Appends a new open-ended top band; the previous top gets a provisional upper bound the owner must confirm. */
export function addTopBand<T extends LayoutDraftRow>(rows: readonly T[], make: (label: string) => T, label: string): T[] {
  const next = rows.map((row) => ({ ...row }));
  if (next.length >= MAX_ACTIVE_DOG_BANDS) return next;
  const finite = next.slice(0, -1).map((row) => Number(row.upper)).filter((value) => Number.isFinite(value));
  const floor = finite.length ? finite[finite.length - 1] : 0;
  if (next.length) next[next.length - 1] = { ...next[next.length - 1], upper: kg(floor + 10), inclusive: false };
  next.push(make(label));
  return next;
}

/** Swaps which band covers two adjacent weight ranges; the cutoffs stay where they are. */
export function moveBand<T extends LayoutDraftRow>(rows: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || index >= rows.length || target >= rows.length) return rows.map((row) => ({ ...row }));
  const next = rows.map((row) => ({ ...row }));
  const a = next[index], b = next[target];
  next[index] = { ...a, id: b.id, label: b.label };
  next[target] = { ...b, id: a.id, label: a.label };
  return next;
}

/** Display-only preview of which draft band a weight falls into (the database re-bands pets). */
export function previewDraftLabel(rows: readonly LayoutDraftRow[], weightKg: number): string | null {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  for (let index = 0; index < rows.length; index += 1) {
    if (index === rows.length - 1) return rows[index].label;
    const upper = Number(rows[index].upper);
    if (!Number.isFinite(upper)) return null;
    if (weightKg < upper || (rows[index].inclusive && weightKg === upper)) return rows[index].label;
  }
  return null;
}

/** Same rule on a stored band list (used by the shared golden-vector test; display only). */
export function previewBandKey(bands: readonly Pick<SizeBand, "key" | "upperKg" | "upperInclusive">[], weightKg: number): string | null {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  for (const band of bands) {
    if (band.upperKg === null || weightKg < band.upperKg || (band.upperInclusive && weightKg === band.upperKg)) return band.key;
  }
  return null;
}

/** Pure mirror used only for UI previews/tests; persisted decisions always use the SQL resolver. */
export function bandForWeight(bands: readonly Pick<SizeBand, "key" | "upperKg" | "upperInclusive" | "sortOrder">[], weightKg: number): string | null {
  return previewBandKey([...bands].sort((left, right) => left.sortOrder - right.sortOrder), weightKg);
}

export interface PreviewService {
  durationMinutes: number;
  basePrice: number;
  additionalDurationMinutes?: number;
  bandPrices?: Record<string, BandPrice>;
  speciesPricing?: Record<string, { price: number; duration: number }>;
}

/** Mirrors resolve_service_line over server-loaded keys/rows. Never accepts a client-submitted key. */
export function resolveForPricingKey(service: PreviewService, species: string, pricingKey: string | null, quantity = 1): { price: number; duration: number; band: string | null } {
  const extra = (service.additionalDurationMinutes ?? 0) * Math.max(0, quantity - 1);
  if (species !== "dog" && species !== "cat") {
    const custom = service.speciesPricing?.[species];
    return { band: pricingKey, price: custom?.price ?? service.basePrice, duration: (custom?.duration ?? 0) + extra };
  }
  const row = pricingKey ? service.bandPrices?.[pricingKey] : undefined;
  return { band: pricingKey, price: row?.price ?? service.basePrice, duration: (row?.duration ?? service.durationMinutes) + extra };
}

// ------------------------------------------------------------ impact / errors

export interface LayoutImpact {
  petsMeasured: number;
  petsRebanded: number;
  byChange: Array<{ from: string | null; to: string | null; count: number }>;
  packageConflicts: number;
}

export function parseImpact(raw: unknown): LayoutImpact | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const byChange = Array.isArray(value.by_change) ? value.by_change : [];
  return {
    petsMeasured: Number(value.pets_measured ?? 0),
    petsRebanded: Number(value.pets_rebanded ?? 0),
    packageConflicts: Number(value.package_conflicts ?? 0),
    byChange: byChange.map((item) => {
      const entry = item as Record<string, unknown>;
      return { from: typeof entry.from === "string" ? entry.from : null, to: typeof entry.to === "string" ? entry.to : null, count: Number(entry.count ?? 0) };
    }),
  };
}

export function describeImpact(impact: LayoutImpact, labelOf: (key: string | null) => string): string[] {
  const lines: string[] = [];
  lines.push(impact.petsRebanded === 0
    ? "Tidak ada anjing terukur yang berpindah kategori."
    : `${impact.petsRebanded} dari ${impact.petsMeasured} anjing terukur akan berpindah kategori.`);
  for (const change of impact.byChange) lines.push(`${change.count} anjing: ${labelOf(change.from) || "tanpa kategori"} → ${labelOf(change.to) || "tanpa kategori"}`);
  if (impact.packageConflicts > 0) lines.push(`${impact.packageConflicts} paket aktif akan tidak cocok dengan kategori hewannya; simpan akan ditolak.`);
  return lines;
}

const ERROR_TEXT: Record<string, string> = {
  not_authorized: "Anda tidak memiliki izin untuk mengubah kategori ukuran.",
  dynamic_mode_required: "Kategori ukuran dinamis belum diaktifkan untuk bisnis ini. Hubungi tim Operro untuk mengaktifkannya.",
  stale_layout: "Pengaturan ukuran sudah diubah orang lain. Muat ulang halaman, lalu ulangi perubahan Anda.",
  invalid_size_layout: "Susunan kategori tidak valid. Periksa nama, batas kg, dan urutan.",
  active_package_size_would_change: "Ada paket aktif yang akan tidak cocok dengan kategori hewannya. Selesaikan atau tinjau paket itu terlebih dahulu.",
  size_band_in_use: "Kategori masih dipakai.",
  size_band_cat_permanent: "Kategori Cat bersifat permanen dan tidak dapat diarsipkan atau dihapus.",
  size_band_not_active: "Kategori ini sudah diarsipkan.",
  size_band_not_archived: "Arsipkan kategori terlebih dahulu sebelum menghapus permanen.",
  last_size_band: "Minimal satu kategori anjing harus aktif.",
  size_band_not_found: "Kategori tidak ditemukan.",
  organization_unavailable: "Bisnis tidak aktif sehingga pengaturan tidak dapat diubah.",
  invalid_band_prices: "Harga atau durasi per ukuran tidak valid.",
  copy_source_empty: "Kategori sumber belum memiliki harga untuk disalin.",
  service_not_found: "Layanan tidak ditemukan.",
  rollback_blocked_custom_bands: "Tidak dapat kembali ke mode lama selama kategori khusus masih aktif. Arsipkan kategori tambahan terlebih dahulu.",
  invalid_mode: "Mode tidak valid.",
};

function parseDetail(detail: string | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try { const value = JSON.parse(detail); return value && typeof value === "object" ? value as Record<string, unknown> : null; } catch { return null; }
}

/** Translate a PostgREST error (message = SQL error code, details = optional JSON) into owner-facing text. */
export function mapSizeBandError(error: { message?: string | null; details?: string | null } | null | undefined): string {
  const code = (error?.message ?? "").trim();
  const detail = parseDetail(error?.details);
  if (code === "size_band_in_use" && detail) {
    const parts: string[] = [];
    const add = (key: string, text: string) => { const count = Number(detail[key] ?? 0); if (count > 0) parts.push(`${count} ${text}`); };
    add("manual_pets", "anjing berukuran manual (tanpa berat)");
    add("sellable_packages", "paket yang masih dijual");
    add("pets", "hewan (termasuk yang dihapus)");
    add("packages", "paket (termasuk nonaktif)");
    add("entitlements", "saldo paket terjual");
    add("lines", "baris booking/invoice lama");
    add("payroll", "pengaturan payroll");
    add("prices", "harga layanan per ukuran");
    return `Kategori masih dipakai oleh ${parts.join(", ") || "data lain"}. Pindahkan atau selesaikan dulu${detail.manual_pets || detail.sellable_packages ? "" : "; kategori lama sebaiknya tetap diarsipkan agar riwayat terbaca"}.`;
  }
  if (code === "active_package_size_would_change" && detail && Number(detail.package_conflicts) > 0) {
    return `${Number(detail.package_conflicts)} paket aktif akan tidak cocok dengan kategori hewannya. Selesaikan atau tinjau paket itu terlebih dahulu.`;
  }
  return ERROR_TEXT[code] ?? "Perubahan belum tersimpan. Periksa isian lalu coba lagi.";
}

// ------------------------------------------------------------------ price form

export const BAND_PRICE_PREFIX = "band_price__";
export const BAND_DURATION_PREFIX = "band_duration__";

export function bandFieldNames(key: string): { price: string; duration: string } {
  return { price: `${BAND_PRICE_PREFIX}${key}`, duration: `${BAND_DURATION_PREFIX}${key}` };
}

export interface BandPriceItem { band_key: string; price?: number | null; duration_minutes?: number | null }
type FormReader = { get(name: string): FormDataEntryValue | null };

/** Reads the dynamic-mode price fields into the RPC payload. Blank = no override (base price/duration). */
export function parseBandPriceForm(form: FormReader, columns: readonly BandColumn[], zeroTime: boolean): { items: BandPriceItem[] } | { invalid: string } {
  const items: BandPriceItem[] = [];
  for (const column of columns) {
    const names = bandFieldNames(column.key);
    const priceText = String(form.get(names.price) ?? "").trim();
    const durationText = zeroTime ? "" : String(form.get(names.duration) ?? "").trim();
    let price: number | null = null, duration: number | null = null;
    if (priceText) {
      price = Number(priceText);
      if (!Number.isFinite(price) || price < 0 || price > 999_999_999) return { invalid: `harga untuk ukuran ${column.label} tidak valid` };
    }
    if (durationText) {
      duration = Number(durationText);
      if (!Number.isInteger(duration) || duration < 15 || duration > 1440) return { invalid: `durasi untuk ukuran ${column.label} tidak valid` };
    }
    if (price === null && duration === null) continue;
    items.push({ band_key: column.key, price, duration_minutes: duration });
  }
  return { items };
}

/** Index of the nearest smaller band in the column list, for the "copy from previous band" button. */
export function previousColumnKey(columns: readonly BandColumn[], key: string): string | null {
  const dogs = columns.filter((column) => column.kind === "dog_weight");
  const index = dogs.findIndex((column) => column.key === key);
  return index > 0 ? dogs[index - 1].key : null;
}

export function copyBandValues<T extends { price: string; duration: string }>(values: Record<string, T>, columns: readonly BandColumn[], key: string): Record<string, T> {
  const source = previousColumnKey(columns, key);
  if (!source || !values[source]) return values;
  return { ...values, [key]: { ...values[key], price: values[source].price, duration: values[source].duration } };
}

/** Legacy-mode starter prices are indexed by the historical keys. */
const STARTER_INDEX: Record<string, number> = { extra_small: 0, small: 1, medium: 2, large: 3, extra_large: 4, cat: 5 };
export function starterIndexForBand(key: string): number | null { return key in STARTER_INDEX ? STARTER_INDEX[key] : null; }
