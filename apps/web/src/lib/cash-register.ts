/**
 * Function index:
 * - loadCashRegister: position per visible account (app.cash_register_position) and a keyset page of movements.
 * - parsePositionRows / parseMovementRows: shape database rows (pure).
 * - groupBalancesByCurrency: per-currency totals; balances of different currencies are never added together.
 * - KIND_LABELS / SOURCE_LABELS / validateMovementForm: display text and browser-side input checks (display only -
 *   the database re-validates everything and derives organization, branch, currency and direction itself).
 *
 * This is a cash-CONTROL register of declared movements (migration 20261031110000), not an accounting ledger: payments,
 * refunds, expenses and payroll do not move these balances, and nothing here is bank-reconciled.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const ACCOUNT_KINDS = ["cash", "bank", "ewallet", "other"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const MOVEMENT_KINDS = ["opening_balance", "capital_contribution", "owner_withdrawal", "cash_in", "cash_out"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const SOURCE_TYPES = ["expense", "payment", "refund"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = { cash: "Kas tunai", bank: "Rekening bank", ewallet: "E-wallet", other: "Lainnya" };
export const KIND_LABELS: Record<MovementKind | "reversal", string> = {
  opening_balance: "Saldo awal", capital_contribution: "Setoran modal", owner_withdrawal: "Penarikan pemilik",
  cash_in: "Kas masuk lain", cash_out: "Kas keluar lain", reversal: "Pembalikan",
};
export const SOURCE_LABELS: Record<SourceType, string> = { expense: "Pengeluaran", payment: "Pembayaran", refund: "Refund" };
/** Which movement kinds may carry which source link (mirrors the database rule). */
export const SOURCE_FOR_KIND: Partial<Record<MovementKind, readonly SourceType[]>> = { cash_in: ["payment"], cash_out: ["expense", "refund"] };

export interface AccountPosition {
  id: string; name: string; kind: AccountKind; currency: string; branchId: string | null; status: "active" | "archived"; version: number;
  totalIn: number; totalOut: number; balance: number; movementCount: number; lastMovementOn: string | null;
}
export interface CashMovement {
  id: string; accountId: string; kind: MovementKind | "reversal"; direction: "in" | "out"; amount: number; currency: string; occurredOn: string;
  counterparty: string | null; memo: string | null; sourceType: SourceType | null; sourceId: string | null; reversalOf: string | null; createdAt: string;
}
export interface MovementCursor { occurredOn: string; id: string }
export interface CashRegister { accounts: AccountPosition[]; movements: CashMovement[]; hasMore: boolean; nextCursor: MovementCursor | null; reversed: ReadonlySet<string> }
export interface CurrencyBalance { currency: string; balance: number; accounts: number }

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function parsePositionRows(data: unknown): AccountPosition[] {
  return (Array.isArray(data) ? data : []).flatMap((row: Row) => {
    if (typeof row?.account_id !== "string" || typeof row.currency !== "string") return [];
    return [{
      id: row.account_id, name: String(row.account_name ?? ""), kind: (ACCOUNT_KINDS as readonly string[]).includes(String(row.kind)) ? (row.kind as AccountKind) : "other",
      currency: row.currency, branchId: str(row.branch_id), status: row.status === "archived" ? "archived" as const : "active" as const, version: num(row.version),
      totalIn: num(row.total_in), totalOut: num(row.total_out), balance: num(row.balance), movementCount: num(row.movement_count), lastMovementOn: str(row.last_movement_on),
    }];
  });
}

export function parseMovementRows(data: unknown): CashMovement[] {
  return (Array.isArray(data) ? data : []).flatMap((row: Row) => {
    if (typeof row?.id !== "string" || typeof row.account_id !== "string") return [];
    return [{
      id: row.id, accountId: row.account_id, kind: row.kind as CashMovement["kind"], direction: row.direction === "out" ? "out" as const : "in" as const,
      amount: num(row.amount), currency: String(row.currency ?? ""), occurredOn: String(row.occurred_on ?? ""), counterparty: str(row.counterparty), memo: str(row.memo),
      sourceType: (SOURCE_TYPES as readonly string[]).includes(String(row.source_type)) ? (row.source_type as SourceType) : null, sourceId: str(row.source_id),
      reversalOf: str(row.reversal_of), createdAt: String(row.created_at ?? ""),
    }];
  });
}

/** Active and archived accounts are both summed: an archived account has a zero balance by rule. */
export function groupBalancesByCurrency(accounts: readonly AccountPosition[]): CurrencyBalance[] {
  const totals = new Map<string, CurrencyBalance>();
  for (const account of accounts) {
    const entry = totals.get(account.currency) ?? { currency: account.currency, balance: 0, accounts: 0 };
    entry.balance += account.balance; entry.accounts += 1;
    totals.set(account.currency, entry);
  }
  return [...totals.values()]
    .map((entry) => ({ ...entry, balance: Math.round(entry.balance * 100) / 100 }))
    .sort((a, b) => (a.currency === "IDR" ? -1 : b.currency === "IDR" ? 1 : a.currency.localeCompare(b.currency)));
}

export const MOVEMENT_PAGE_SIZE = 50;

export async function loadCashRegister(supabase: SupabaseClient, cursor: MovementCursor | null = null): Promise<CashRegister> {
  const position = await supabase.schema("app").rpc("cash_register_position", { p_as_of: null });
  if (position.error) throw new Error(`cash_register_position_failed:${position.error.code ?? ""}`);
  const accounts = parsePositionRows(position.data);
  if (accounts.length === 0) return { accounts, movements: [], hasMore: false, nextCursor: null, reversed: new Set() };
  // RLS (organization, finance.read, branch) decides which rows are visible; no organization id is sent.
  let query = supabase.from("cash_movements")
    .select("id,account_id,kind,direction,amount,currency,occurred_on,counterparty,memo,source_type,source_id,reversal_of,created_at")
    .order("occurred_on", { ascending: false }).order("id", { ascending: false }).limit(MOVEMENT_PAGE_SIZE + 1);
  if (cursor) query = query.or(`occurred_on.lt.${cursor.occurredOn},and(occurred_on.eq.${cursor.occurredOn},id.lt.${cursor.id})`);
  const result = await query;
  if (result.error) throw new Error(`cash_movements_failed:${result.error.code ?? ""}`);
  const all = parseMovementRows(result.data);
  const hasMore = all.length > MOVEMENT_PAGE_SIZE;
  const movements = hasMore ? all.slice(0, MOVEMENT_PAGE_SIZE) : all;
  const last = movements[movements.length - 1];
  // Which of the shown movements already have a reversal (the reversal may be on another page: ask for them explicitly).
  const ids = movements.filter((movement) => movement.kind !== "reversal").map((movement) => movement.id);
  const reversed = new Set<string>();
  if (ids.length > 0) {
    const reversals = await supabase.from("cash_movements").select("reversal_of").in("reversal_of", ids);
    if (reversals.error) throw new Error(`cash_reversals_failed:${reversals.error.code ?? ""}`);
    for (const row of (reversals.data ?? []) as Row[]) if (typeof row.reversal_of === "string") reversed.add(row.reversal_of);
  }
  return { accounts, movements, hasMore, nextCursor: hasMore && last ? { occurredOn: last.occurredOn, id: last.id } : null, reversed };
}

export interface MovementFormInput { kind: string; amount: string; occurredOn: string; counterparty: string; memo: string; sourceType: string; sourceId: string }

/** Display-only pre-check so obvious mistakes never reach the server; the database repeats every rule. */
export function validateMovementForm(input: MovementFormInput, today: string): { ok: true; amount: number } | { ok: false; message: string } {
  if (!(MOVEMENT_KINDS as readonly string[]).includes(input.kind)) return { ok: false, message: "Jenis mutasi tidak valid." };
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input.amount.trim())) return { ok: false, message: "Jumlah harus angka positif dengan maksimal dua desimal." };
  const amount = Number(input.amount.trim());
  if (!(amount > 0) || amount >= 1_000_000_000_000) return { ok: false, message: "Jumlah harus lebih dari nol dan di bawah satu triliun." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn) || input.occurredOn < "2000-01-01" || input.occurredOn > today) return { ok: false, message: "Tanggal tidak valid atau di masa depan." };
  if ((input.kind === "capital_contribution" || input.kind === "owner_withdrawal") && input.counterparty.trim() === "") return { ok: false, message: "Nama pihak wajib diisi untuk setoran modal atau penarikan pemilik." };
  if (input.counterparty.trim().length > 80 || input.memo.trim().length > 300) return { ok: false, message: "Nama pihak maksimal 80 dan catatan maksimal 300 karakter." };
  if ((input.sourceType === "") !== (input.sourceId.trim() === "")) return { ok: false, message: "Tautan sumber memerlukan jenis dan ID sumber sekaligus." };
  if (input.sourceType !== "") {
    const allowed = SOURCE_FOR_KIND[input.kind as MovementKind];
    if (!allowed || !(allowed as readonly string[]).includes(input.sourceType)) return { ok: false, message: "Jenis sumber tidak cocok dengan jenis mutasi." };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sourceId.trim())) return { ok: false, message: "ID sumber harus berupa UUID." };
  }
  return { ok: true, amount };
}

/** Maps database error codes/messages to plain Indonesian; unknown errors never leak raw text. */
export function describeCashError(error: { code?: string; message?: string }): string {
  const message = error.message ?? "";
  if (error.code === "42501") return "Anda tidak memiliki izin untuk aksi ini (finance.manage, dan akses semua cabang untuk akun lintas cabang).";
  if (error.code === "40001" || /stale_account/.test(message)) return "Data akun sudah berubah. Muat ulang halaman, lalu coba lagi.";
  if (/duplicate_account_name/.test(message)) return "Nama akun sudah dipakai.";
  if (/account_limit_reached/.test(message)) return "Batas 20 akun aktif tercapai.";
  if (/opening_balance_exists/.test(message)) return "Akun ini sudah memiliki saldo awal. Balik dulu saldo awal lama jika salah.";
  if (/source_already_linked/.test(message)) return "Sumber ini sudah ditautkan ke akun tersebut. Balik mutasi lama untuk menautkan ulang.";
  if (/currency_mismatch/.test(message)) return "Mata uang sumber berbeda dari mata uang akun.";
  if (/source_not_found/.test(message)) return "Sumber tidak ditemukan, tidak berhasil, atau di luar cabang Anda.";
  if (/account_archived/.test(message)) return "Akun diarsipkan. Aktifkan kembali sebelum mencatat mutasi.";
  if (/balance_not_zero/.test(message)) return "Akun hanya dapat diarsipkan saat saldonya nol. Catat mutasi penutup lebih dulu.";
  if (/already_reversed/.test(message)) return "Mutasi ini sudah dibalik.";
  if (/cannot_reverse_a_reversal/.test(message)) return "Pembalikan tidak dapat dibalik. Catat mutasi baru.";
  if (/request_conflict/.test(message)) return "Permintaan ini sudah dipakai untuk data lain. Muat ulang halaman.";
  if (error.code === "P0002") return "Data tidak ditemukan atau di luar akses Anda.";
  if (error.code === "22023") return "Input tidak valid. Periksa jumlah, tanggal, dan catatan.";
  return "Permintaan belum dapat diproses. Coba lagi.";
}
