/**
 * Function index:
 * - parseSizeMatrix: validates the submitted per-size Basic Grooming matrix against the
 *   organization's OWN dog size bands (loaded server-side under the caller's session), never
 *   against a fixed key list. Blank entries never reach this function (the editor omits them),
 *   so an absent key means "no band-specific rate" and a present 0 is a deliberate zero.
 * - sizeMatrixRows: the rows the editor shows -- every active band in weight order, plus any
 *   archived band that still holds a stored rate (so it can be seen and cleared, never silently
 *   dropped or silently kept).
 * - perDogDetailRows: shapes the additive `perDogDetail` of a calculated breakdown for display.
 *
 * Authority: the database trigger trg_*_validate_size_matrix (20261027100000) is the final
 * validator; this module only gives early, friendly feedback and keeps the form honest. It
 * never decides a payroll amount.
 */

export interface PayrollSizeBand { key: string; label: string; status: "active" | "archived"; sortOrder: number }
export type SizeMatrix = Record<string, number>;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_RATE = 1_000_000_000_000;

export function activeSizeKeys(bands: readonly PayrollSizeBand[]): Set<string> {
  return new Set(bands.filter((band) => band.status === "active").map((band) => band.key));
}

/**
 * `stored` is the matrix currently saved for the same row (org default or one staff member).
 * An unchanged stored rate for a key that is no longer an active band (archived) is accepted
 * so an unrelated save never fails; a new or changed rate for such a key is refused.
 */
export function parseSizeMatrix(
  raw: FormDataEntryValue | null, bands: readonly PayrollSizeBand[], stored: SizeMatrix | null,
): ParseResult<SizeMatrix> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "format matriks ukuran tidak valid (JSON rusak)" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: "format matriks ukuran harus berupa objek" };
  const active = activeSizeKeys(bands);
  const labels = new Map(bands.map((band) => [band.key, band.label]));
  const out: SizeMatrix = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val >= MAX_RATE) {
      return { ok: false, error: `nilai untuk ukuran ${labels.get(key) ?? key} harus angka >= 0` };
    }
    if (!active.has(key)) {
      const unchanged = stored !== null && Object.prototype.hasOwnProperty.call(stored, key) && Number(stored[key]) === val;
      if (!unchanged) {
        return { ok: false, error: labels.has(key)
          ? `ukuran ${labels.get(key)} sudah diarsipkan; hanya bisa dikosongkan`
          : `ukuran tidak dikenal atau sudah tidak aktif: ${key}` };
      }
    }
    out[key] = val;
  }
  return { ok: true, value: out };
}

export interface SizeMatrixRow { key: string; label: string; archived: boolean; value: number | null }

export function sizeMatrixRows(bands: readonly PayrollSizeBand[], stored: SizeMatrix | null): SizeMatrixRow[] {
  const ordered = [...bands].sort((a, b) => a.sortOrder - b.sortOrder);
  const has = (key: string) => stored !== null && Object.prototype.hasOwnProperty.call(stored, key) && stored[key] != null;
  return ordered
    .filter((band) => band.status === "active" || has(band.key))
    .map((band) => ({ key: band.key, label: band.label, archived: band.status === "archived", value: has(band.key) ? Number(stored![band.key]) : null }));
}

export interface PerDogDetailEntry { key: string | null; label: string | null; count: number; rate: number; amount: number }

/** Missing on breakdowns frozen before SB-06: callers treat an empty result as "no per-size detail". */
export function perDogDetailRows(detail: unknown): PerDogDetailEntry[] {
  if (!Array.isArray(detail)) return [];
  const rows: PerDogDetailEntry[] = [];
  for (const item of detail) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const count = Number(row.count); const rate = Number(row.rate);
    if (!Number.isFinite(count) || !Number.isFinite(rate)) continue;
    rows.push({
      key: typeof row.key === "string" ? row.key : null,
      label: typeof row.label === "string" ? row.label : null,
      count, rate, amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : count * rate,
    });
  }
  return rows;
}

export const UNSIZED_LABEL = "Tanpa ukuran (tarif flat)";
