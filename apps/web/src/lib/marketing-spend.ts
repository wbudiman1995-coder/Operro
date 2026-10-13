/**
 * Function index:
 * - loadMarketingSpend: a keyset page of spend entries (RLS decides visibility) plus which of them are already reversed.
 * - loadSourceReturn: the per-source, per-currency return for one period (app.dashboard_source_roi).
 * - parseSpendRows / parseSourceReturnRows: shape database rows (pure).
 * - groupSpendByCurrency: net spend per currency; currencies are never added together.
 * - validateSpendForm / describeSpendError: display-only input checks and plain-language error mapping.
 * - RETURN_DEFINITION: the one attribution rule, shown next to every figure.
 *
 * Migration 20261101100000. Spend is a person's declaration of what they spent on one source on one day; it is not read from
 * any ad platform. The return compares CASH COLLECTED IN THE PERIOD from customers created in the same period under that
 * source with the net spend recorded for the same source in the period. It is not lifetime value, campaign attribution or
 * profit, and it needs a spend figure: without one, no ratio exists and none is shown.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const RETURN_DEFINITION = [
  "Sumber adalah isian “sumber” pada profil pelanggan saat ini (huruf besar/kecil dan spasi diseragamkan), sama seperti tabel di atas.",
  "Pelanggan baru: pelanggan tidak diarsipkan yang dibuat pada periode ini. Pendapatan: pembayaran berhasil menurut tanggal bayar pada periode ini dari pelanggan tersebut, dikurangi refund berhasil menurut tanggal refund pada periode yang sama.",
  "Biaya: biaya pemasaran yang dicatat manual untuk sumber itu pada periode ini, dikurangi pembalikannya. Rasio = pendapatan bersih dibagi biaya, hanya ditampilkan bila biaya lebih dari nol.",
  "Ini bukan nilai seumur hidup pelanggan, bukan atribusi kampanye, dan bukan laba. Pelanggan yang membayar setelah periode tidak ikut dihitung. Mata uang berbeda tidak digabung maupun dikonversi.",
] as const;

export interface SpendEntry {
  id: string; kind: "spend" | "reversal"; sourceLabel: string; sourceKey: string; spentOn: string; amount: number; currency: string;
  note: string | null; reversalOf: string | null; createdAt: string;
}
export interface SpendCursor { spentOn: string; id: string }
export interface MarketingSpend { entries: SpendEntry[]; hasMore: boolean; nextCursor: SpendCursor | null; reversed: ReadonlySet<string> }
export interface CurrencySpend { currency: string; net: number; entries: number }

export interface SourceReturnRow {
  key: string; label: string; currency: string;
  spend: number; spendEntries: number; cohortCustomers: number; payingCustomers: number;
  collected: number; refunded: number; netRevenue: number; netResult: number;
  /** null whenever no spend is recorded: a ratio without a denominator is never invented. */
  ratio: number | null; hasSpend: boolean;
}
export interface SourceReturn { rows: SourceReturnRow[]; truncated: boolean }
export const RETURN_ROW_LIMIT = 50;

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function parseSpendRows(data: unknown): SpendEntry[] {
  return (Array.isArray(data) ? data : []).flatMap((row: Row) => {
    if (typeof row?.id !== "string" || typeof row.currency !== "string") return [];
    return [{
      id: row.id, kind: row.kind === "reversal" ? "reversal" as const : "spend" as const,
      sourceLabel: String(row.source_label ?? ""), sourceKey: String(row.source_key ?? ""), spentOn: String(row.spent_on ?? ""),
      amount: num(row.amount), currency: row.currency, note: str(row.note), reversalOf: str(row.reversal_of), createdAt: String(row.created_at ?? ""),
    }];
  });
}

export function parseSourceReturnRows(data: unknown): SourceReturn {
  const rows = (Array.isArray(data) ? data : []).flatMap((row: Row) => {
    if (typeof row?.source_key !== "string" || typeof row.currency !== "string") return [];
    const spend = num(row.spend);
    const hasSpend = row.has_spend === true && spend > 0;
    const ratio = hasSpend && row.ratio !== null && row.ratio !== undefined ? num(row.ratio) : null;
    return [{
      key: row.source_key, label: typeof row.source_label === "string" && row.source_label !== "" ? row.source_label : row.source_key, currency: row.currency,
      spend, spendEntries: num(row.spend_entries), cohortCustomers: num(row.cohort_customers), payingCustomers: num(row.paying_customers),
      collected: num(row.collected), refunded: num(row.refunded), netRevenue: num(row.net_revenue), netResult: num(row.net_result), ratio, hasSpend,
    }];
  });
  return { rows: rows.slice(0, RETURN_ROW_LIMIT), truncated: rows.length > RETURN_ROW_LIMIT };
}

/** Ratio text such as "1,96×"; "—" when there is no spend (never zero, never infinity). */
export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  return `${new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ratio)}×`;
}

export function groupSpendByCurrency(entries: readonly SpendEntry[]): CurrencySpend[] {
  const totals = new Map<string, CurrencySpend>();
  for (const entry of entries) {
    const item = totals.get(entry.currency) ?? { currency: entry.currency, net: 0, entries: 0 };
    item.net += entry.kind === "spend" ? entry.amount : -entry.amount;
    item.entries += entry.kind === "spend" ? 1 : 0;
    totals.set(entry.currency, item);
  }
  return [...totals.values()].map((item) => ({ ...item, net: Math.round(item.net * 100) / 100 })).sort((a, b) => (a.currency === "IDR" ? -1 : b.currency === "IDR" ? 1 : a.currency.localeCompare(b.currency)));
}

export const SPEND_PAGE_SIZE = 50;

export async function loadMarketingSpend(supabase: SupabaseClient, cursor: SpendCursor | null = null): Promise<MarketingSpend> {
  // RLS (organization, finance.read, branches.all, not a Groomer) decides which rows are visible; no organization id is sent.
  let query = supabase.from("marketing_spend_entries")
    .select("id,kind,source_label,source_key,spent_on,amount,currency,note,reversal_of,created_at")
    .order("spent_on", { ascending: false }).order("id", { ascending: false }).limit(SPEND_PAGE_SIZE + 1);
  if (cursor) query = query.or(`spent_on.lt.${cursor.spentOn},and(spent_on.eq.${cursor.spentOn},id.lt.${cursor.id})`);
  const result = await query;
  if (result.error) throw new Error(`marketing_spend_failed:${result.error.code ?? ""}`);
  const all = parseSpendRows(result.data);
  const hasMore = all.length > SPEND_PAGE_SIZE;
  const entries = hasMore ? all.slice(0, SPEND_PAGE_SIZE) : all;
  const last = entries[entries.length - 1];
  const ids = entries.filter((entry) => entry.kind === "spend").map((entry) => entry.id);
  const reversed = new Set<string>();
  if (ids.length > 0) {
    const reversals = await supabase.from("marketing_spend_entries").select("reversal_of").in("reversal_of", ids);
    if (reversals.error) throw new Error(`marketing_reversals_failed:${reversals.error.code ?? ""}`);
    for (const row of (reversals.data ?? []) as Row[]) if (typeof row.reversal_of === "string") reversed.add(row.reversal_of);
  }
  return { entries, hasMore, nextCursor: hasMore && last ? { spentOn: last.spentOn, id: last.id } : null, reversed };
}

export async function loadSourceReturn(supabase: SupabaseClient, from: string, to: string, timeZone: string): Promise<SourceReturn> {
  const { data, error } = await supabase.schema("app").rpc("dashboard_source_roi", { p_from: from, p_to: to, p_timezone: timeZone });
  if (error) throw Object.assign(new Error(`dashboard_source_roi_failed:${error.code ?? ""}`), { code: error.code });
  return parseSourceReturnRows(data);
}

export interface SpendFormInput { source: string; amount: string; currency: string; spentOn: string; note: string }

/** Display-only pre-check; the database repeats every rule and derives organization and user itself. */
export function validateSpendForm(input: SpendFormInput, today: string): { ok: true; amount: number; source: string; currency: string } | { ok: false; message: string } {
  const source = input.source.trim().replace(/\s+/g, " ");
  if (source.length < 1 || source.length > 80 || /[\u0000-\u001f]/.test(source)) return { ok: false, message: "Sumber wajib diisi (1–80 karakter)." };
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input.amount.trim())) return { ok: false, message: "Jumlah harus angka positif dengan maksimal dua desimal." };
  const amount = Number(input.amount.trim());
  if (!(amount > 0) || amount >= 1_000_000_000_000) return { ok: false, message: "Jumlah harus lebih dari nol dan di bawah satu triliun." };
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, message: "Mata uang harus tiga huruf, misalnya IDR." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn) || input.spentOn < "2000-01-01" || input.spentOn > today) return { ok: false, message: "Tanggal tidak valid atau di masa depan." };
  if (input.note.trim().length > 200) return { ok: false, message: "Catatan maksimal 200 karakter." };
  return { ok: true, amount, source, currency };
}

/** Plain Indonesian; unknown errors never leak raw database text. */
export function describeSpendError(error: { code?: string; message?: string }): string {
  const message = error.message ?? "";
  if (error.code === "42501") return "Anda tidak memiliki izin mencatat biaya pemasaran (finance.manage dan akses semua cabang).";
  if (/already_reversed/.test(message)) return "Biaya ini sudah dibalik.";
  if (/cannot_reverse_a_reversal/.test(message)) return "Pembalikan tidak dapat dibalik. Catat biaya baru.";
  if (/request_conflict/.test(message)) return "Permintaan ini sudah dipakai untuk data lain. Muat ulang halaman.";
  if (/spend_limit_reached/.test(message)) return "Batas 20.000 catatan biaya tercapai.";
  if (error.code === "P0002") return "Data tidak ditemukan atau di luar akses Anda.";
  if (error.code === "22023") return "Input tidak valid. Periksa sumber, jumlah, mata uang, tanggal, dan catatan.";
  return "Permintaan belum dapat diproses. Coba lagi.";
}
