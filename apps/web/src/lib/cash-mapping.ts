/**
 * Function index:
 * - loadCashOnHand: per visible account, the mapped cash position (app.cash_on_hand) and what it leaves out (app.cash_unmapped_flows).
 * - loadCashMappings: the mapping history (RLS decides visibility).
 * - parseOnHandRows / parseUnmappedRows / parseMappingRows: shape database rows (pure).
 * - summarizeOnHand: per-currency totals over COMPLETE accounts only; incomplete accounts are never summed.
 * - validateMappingForm / describeMappingError: display-only input checks and plain-language error mapping.
 *
 * Migration 20261101110000. The position is: declared register movements + payments mapped to the account - mapped refunds,
 * expenses and payroll paid, each counted only from the effective date of the mapping that applies to it. It is only as true as
 * the owner's mappings and declared opening balance. It is NOT a bank reconciliation, a ledger or profit, and flows without a
 * mapping (or in another currency) are listed separately instead of being left out silently.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const MAPPING_FLOWS = ["payment", "expense", "payroll"] as const;
export type MappingFlow = (typeof MAPPING_FLOWS)[number];
export const PAYMENT_METHODS = ["cash", "card", "wallet", "bank_transfer", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const FLOW_LABELS: Record<MappingFlow, string> = { payment: "Pembayaran diterima", expense: "Pengeluaran", payroll: "Gaji dibayar" };
export const METHOD_LABELS: Record<PaymentMethod, string> = { cash: "Tunai", card: "Kartu", wallet: "E-wallet", bank_transfer: "Transfer bank", other: "Lainnya (mis. QRIS)" };
export const FLOW_KIND_LABELS: Record<string, string> = { payment: "Pembayaran", refund: "Refund", expense: "Pengeluaran", payroll: "Gaji" };
export const UNMAPPED_REASON_LABELS: Record<string, string> = {
  not_mapped: "Belum dipetakan ke akun",
  currency_mismatch: "Mata uang berbeda dari akun tujuan",
  already_declared: "Sudah dicatat manual di register (tidak dihitung dua kali)",
};
export const ON_HAND_DEFINITION = [
  "Kas di tangan (terpetakan) = mutasi yang Anda catat di register + pembayaran yang dipetakan ke akun − refund, pengeluaran, dan gaji dibayar yang dipetakan ke akun.",
  "Setiap arus hanya dihitung sejak tanggal berlaku pemetaannya. Catat saldo awal pada tanggal berlaku agar tidak ada yang terhitung dua kali.",
  "Pembayaran, refund, dan pengeluaran memakai baris dan tanggal yang sama dengan laporan Posisi kas; gaji memakai catatan gaji dibayar di buku keuangan.",
  "Ini bukan rekonsiliasi bank, bukan buku besar, dan bukan laba. Saldo hanya sebaik pemetaan dan saldo awal yang Anda catat.",
] as const;

export interface OnHandAccount {
  id: string; name: string; kind: string; currency: string; branchId: string | null; status: "active" | "archived";
  declared: number;
  /** null when the caller cannot see every branch an organization-wide account receives: a partial total would mislead. */
  paymentsIn: number | null; refundsOut: number | null; expensesOut: number | null; payrollOut: number | null; balance: number | null;
  complete: boolean; mappedFlows: number | null; firstEffective: string | null;
}
export interface UnmappedFlow { kind: string; currency: string; reason: string; count: number; total: number }
export interface CashMapping {
  id: string; flow: MappingFlow; method: PaymentMethod | null; branchId: string | null; accountId: string | null; effectiveFrom: string; createdAt: string;
}
export interface CashOnHand { accounts: OnHandAccount[]; unmapped: UnmappedFlow[]; hasMappings: boolean }
export interface CurrencyOnHand { currency: string; balance: number; accounts: number }

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function parseOnHandRows(data: unknown): OnHandAccount[] {
  return (Array.isArray(data) ? data : []).flatMap((row: Row) => {
    if (typeof row?.account_id !== "string" || typeof row.currency !== "string") return [];
    const complete = row.mapped_complete === true;
    return [{
      id: row.account_id, name: String(row.account_name ?? ""), kind: String(row.kind ?? "other"), currency: row.currency, branchId: str(row.branch_id),
      status: row.status === "archived" ? "archived" as const : "active" as const, declared: num(row.declared_balance),
      paymentsIn: complete ? nullableNum(row.payments_in) : null, refundsOut: complete ? nullableNum(row.refunds_out) : null,
      expensesOut: complete ? nullableNum(row.expenses_out) : null, payrollOut: complete ? nullableNum(row.payroll_out) : null,
      balance: complete ? nullableNum(row.balance) : null, complete, mappedFlows: complete ? nullableNum(row.mapped_flows) : null, firstEffective: str(row.first_effective),
    }];
  });
}

export function parseUnmappedRows(data: unknown): UnmappedFlow[] {
  return (Array.isArray(data) ? data : []).flatMap((row: Row) => {
    if (typeof row?.kind !== "string" || typeof row.currency !== "string" || typeof row.reason !== "string") return [];
    return [{ kind: row.kind, currency: row.currency, reason: row.reason, count: num(row.flow_count), total: num(row.total_amount) }];
  });
}

export function parseMappingRows(data: unknown): CashMapping[] {
  return (Array.isArray(data) ? data : []).flatMap((row: Row) => {
    if (typeof row?.id !== "string" || !(MAPPING_FLOWS as readonly string[]).includes(String(row.flow))) return [];
    return [{
      id: row.id, flow: row.flow as MappingFlow, method: (PAYMENT_METHODS as readonly string[]).includes(String(row.method)) ? (row.method as PaymentMethod) : null,
      branchId: str(row.branch_id), accountId: str(row.account_id), effectiveFrom: String(row.effective_from ?? ""), createdAt: String(row.created_at ?? ""),
    }];
  });
}

/** Only complete accounts are summed, and only within one currency. */
export function summarizeOnHand(accounts: readonly OnHandAccount[]): CurrencyOnHand[] {
  const totals = new Map<string, CurrencyOnHand>();
  for (const account of accounts) {
    if (!account.complete || account.balance === null) continue;
    const entry = totals.get(account.currency) ?? { currency: account.currency, balance: 0, accounts: 0 };
    entry.balance += account.balance; entry.accounts += 1;
    totals.set(account.currency, entry);
  }
  return [...totals.values()].map((entry) => ({ ...entry, balance: Math.round(entry.balance * 100) / 100 }))
    .sort((a, b) => (a.currency === "IDR" ? -1 : b.currency === "IDR" ? 1 : a.currency.localeCompare(b.currency)));
}

export async function loadCashMappings(supabase: SupabaseClient): Promise<CashMapping[]> {
  const result = await supabase.from("cash_account_mappings")
    .select("id,flow,method,branch_id,account_id,effective_from,created_at")
    .order("effective_from", { ascending: false }).order("created_at", { ascending: false }).limit(200);
  if (result.error) throw new Error(`cash_mappings_failed:${result.error.code ?? ""}`);
  return parseMappingRows(result.data);
}

export async function loadCashOnHand(supabase: SupabaseClient, timeZone: string): Promise<CashOnHand> {
  const [position, unmapped, mappings] = await Promise.all([
    supabase.schema("app").rpc("cash_on_hand", { p_as_of: null, p_timezone: timeZone }),
    supabase.schema("app").rpc("cash_unmapped_flows", { p_as_of: null, p_timezone: timeZone }),
    supabase.from("cash_account_mappings").select("id", { count: "exact", head: true }),
  ]);
  if (position.error) throw Object.assign(new Error(`cash_on_hand_failed:${position.error.code ?? ""}`), { code: position.error.code });
  if (unmapped.error) throw Object.assign(new Error(`cash_unmapped_failed:${unmapped.error.code ?? ""}`), { code: unmapped.error.code });
  if (mappings.error) throw new Error(`cash_mappings_count_failed:${mappings.error.code ?? ""}`);
  return { accounts: parseOnHandRows(position.data), unmapped: parseUnmappedRows(unmapped.data), hasMappings: (mappings.count ?? 0) > 0 };
}

export interface MappingFormInput { flow: string; method: string; branchId: string; accountId: string; effectiveFrom: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display-only pre-check; the database repeats every rule and derives organization and user itself. */
export function validateMappingForm(input: MappingFormInput, today: string): { ok: true } | { ok: false; message: string } {
  if (!(MAPPING_FLOWS as readonly string[]).includes(input.flow)) return { ok: false, message: "Jenis arus tidak valid." };
  if (input.flow === "payment" ? !(PAYMENT_METHODS as readonly string[]).includes(input.method) : input.method !== "") return { ok: false, message: input.flow === "payment" ? "Pilih metode pembayaran." : "Pengeluaran dan gaji tidak memakai metode." };
  if (input.branchId !== "" && !UUID.test(input.branchId)) return { ok: false, message: "Cabang tidak valid." };
  if (input.accountId !== "" && !UUID.test(input.accountId)) return { ok: false, message: "Akun tidak valid." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || input.effectiveFrom < "2000-01-01" || input.effectiveFrom > addDay(today)) return { ok: false, message: "Tanggal berlaku tidak valid atau terlalu jauh ke depan." };
  return { ok: true };
}
function addDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Plain Indonesian; unknown errors never leak raw database text. */
export function describeMappingError(error: { code?: string; message?: string }): string {
  const message = error.message ?? "";
  if (error.code === "42501") return "Anda tidak memiliki izin untuk pemetaan ini (finance.manage; pemetaan seluruh cabang atau akun seluruh cabang memerlukan akses semua cabang).";
  if (/effective_from_not_after_previous/.test(message)) return "Tanggal berlaku tidak boleh lebih awal dari pemetaan sebelumnya untuk arus yang sama. Riwayat tidak dapat ditulis ulang.";
  if (/account_branch_mismatch/.test(message)) return "Akun satu cabang hanya menerima arus cabang itu, dan aturan seluruh cabang hanya mengisi akun seluruh cabang.";
  if (/account_archived/.test(message)) return "Akun diarsipkan. Aktifkan kembali atau pilih akun lain.";
  if (/mapping_limit_reached/.test(message)) return "Batas 500 pemetaan tercapai.";
  if (/request_conflict/.test(message)) return "Permintaan ini sudah dipakai untuk data lain. Muat ulang halaman.";
  if (error.code === "P0002") return "Akun atau cabang tidak ditemukan atau di luar akses Anda.";
  if (error.code === "22023") return "Input tidak valid. Periksa jenis arus, metode, akun, dan tanggal.";
  return "Permintaan belum dapat diproses. Coba lagi.";
}
