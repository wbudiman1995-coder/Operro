/**
 * Section 31 finance export (HomePaw parity gap): the payment register —
 * same filters as the on-screen /finance register — plus operational
 * expenses, as one workbook. Reuses loadPaymentRegister (the SAME
 * RPC-backed loader the register itself renders) and getAll/sheet from
 * homepaw-export.ts. No second, independent read or calculation path.
 */
import "server-only";

import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";

import { groupCashByCurrency, loadCashPosition, type CashPeriod } from "@/lib/cash-position";
import { ACCOUNT_KIND_LABELS, KIND_LABELS, parsePositionRows, type AccountKind, type CashMovement } from "@/lib/cash-register";
import { collectExportPages } from "@/lib/finance-export-pagination";
import { getAll, sheet } from "@/lib/homepaw-export";
import { loadPaymentRegister, type PaymentRegisterCursor, type PaymentRegisterFilters, type PaymentRegisterRow } from "@/lib/payment-register";

export type FinanceExportFilters = Omit<PaymentRegisterFilters, "cursor" | "pageSize">;

// The RPC caps its raw response at 200 rows, while loadPaymentRegister needs
// one sentinel row to detect another page. Request 199 data rows so the 200th
// row remains available as that sentinel. The export therefore caps at 19,900
// payments and fails explicitly if more history exists. This is the same
// bounded-export style as homepaw-export.ts's getAll, sized down because this
// path pays one round trip per page instead of one per 500 rows.
const MAX_PAGES = 100;

async function loadAllPaymentRegisterRows(supabase: SupabaseClient, organizationId: string, filters: FinanceExportFilters) {
  return collectExportPages<PaymentRegisterRow, PaymentRegisterCursor>(
    async (cursor) => loadPaymentRegister(supabase, organizationId, { ...filters, cursor, pageSize: 199 }),
    MAX_PAGES,
  );
}

async function loadPaymentCurrencies(supabase: SupabaseClient, organizationId: string, paymentIds: string[]) {
  const currencies = new Map<string, string>();
  for (let offset = 0; offset < paymentIds.length; offset += 500) {
    const result = await supabase
      .from("payments")
      .select("id,currency")
      .eq("organization_id", organizationId)
      .in("id", paymentIds.slice(offset, offset + 500));
    if (result.error) throw new Error(`finance_export_currency_failed:${result.error.message}`);
    for (const row of result.data ?? []) currencies.set(row.id, row.currency);
  }
  return currencies;
}

async function loadInvoiceNumbers(supabase: SupabaseClient, organizationId: string, invoiceIds: string[]) {
  const numbers = new Map<string, string>();
  for (let offset = 0; offset < invoiceIds.length; offset += 500) {
    const result = await supabase
      .from("invoices")
      .select("id,invoice_number")
      .eq("organization_id", organizationId)
      .in("id", invoiceIds.slice(offset, offset + 500));
    if (result.error) throw new Error(`finance_export_invoice_failed:${result.error.message}`);
    for (const row of result.data ?? []) numbers.set(row.id, row.invoice_number);
  }
  return numbers;
}

export interface FinanceExportCash { period: CashPeriod; timeZone: string }

/**
 * Payments (register filters), all refunds, all expenses, all invoices, the cash-control register (accounts with their
 * position, and every movement) and - when `cash` is given - the read-only cash position for that period. Every sheet
 * comes from RLS-scoped reads of the authoritative tables; nothing is written, nothing is converted between currencies,
 * and no sheet is a profit statement or accounting ledger. Text cells are formula-neutralized by sheet().
 * Bounded: payments 19,900, every other table 50,000 rows; beyond that the export fails explicitly instead of truncating.
 */
export async function buildFinanceExport(supabase: SupabaseClient, organizationId: string, filters: FinanceExportFilters, cash?: FinanceExportCash): Promise<ExcelJS.Workbook> {
  const [paymentRows, expenses, refunds, invoices, registerPosition, registerMovements, cashRows] = await Promise.all([
    loadAllPaymentRegisterRows(supabase, organizationId, filters),
    getAll(supabase, "expenses", organizationId, true),
    getAll(supabase, "refunds", organizationId, false),
    getAll(supabase, "invoices", organizationId, false),
    supabase.schema("app").rpc("cash_register_position", { p_as_of: null }),
    getAll(supabase, "cash_movements", organizationId, false),
    cash ? loadCashPosition(supabase, cash.period, cash.timeZone) : Promise.resolve(null),
  ]);
  if (registerPosition.error) throw new Error(`finance_export_register_failed:${registerPosition.error.code ?? ""}`);
  const accounts = parsePositionRows(registerPosition.data);
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  const refundPaymentIds = [...new Set(refunds.map((row) => String(row.payment_id)))];
  const [paymentCurrencies, refundCurrencies, invoiceNumbers] = await Promise.all([
    loadPaymentCurrencies(supabase, organizationId, paymentRows.map((row) => row.id)),
    loadPaymentCurrencies(supabase, organizationId, refundPaymentIds),
    loadInvoiceNumbers(supabase, organizationId, [...new Set(refunds.flatMap((row) => (row.invoice_id ? [String(row.invoice_id)] : [])))]),
  ]);
  const book = new ExcelJS.Workbook();
  book.creator = "Operro";
  sheet(book, "Pembayaran", ["Invoice", "Pelanggan", "Metode", "Jumlah", "Mata Uang", "Status", "Tahap Review", "Bulan Layanan", "Dibayar Pada", "Dikonfirmasi Oleh", "Divalidasi Oleh"],
    paymentRows.map((r) => [r.invoiceNumber, r.customerName, r.method, r.amount, paymentCurrencies.get(r.id) ?? "", r.status, r.stage, r.serviceMonth, r.paidAt, r.screenshotConfirmedBy, r.bankValidatedBy]));
  sheet(book, "Pengembalian Dana - Semua", ["Invoice", "Jumlah", "Mata Uang", "Status", "Alasan", "Dikembalikan Pada"],
    refunds.map((r) => [r.invoice_id ? invoiceNumbers.get(String(r.invoice_id)) ?? "" : "", Number(r.amount), refundCurrencies.get(String(r.payment_id)) ?? "", r.status, r.reason, r.refunded_at]));
  sheet(book, "Invoice - Semua", ["Nomor Invoice", "Status", "Mata Uang", "Subtotal", "Diskon", "Pajak", "Total", "Terbit", "Jatuh Tempo", "Dibayar Pada"],
    invoices.map((r) => [r.invoice_number, r.status, r.currency, r.subtotal, r.discount_total, r.tax_total, r.total, r.issued_at, r.due_at, r.paid_at]));
  sheet(book, "Pengeluaran - Semua", ["Deskripsi", "Kategori", "Jumlah", "Mata Uang", "Status", "Terjadi Pada"],
    expenses.map((r) => [r.description, r.category, r.amount, r.currency, r.status, r.incurred_at]));
  sheet(book, "Register Akun Kas", ["Akun", "Jenis", "Mata Uang", "Status", "Total Masuk", "Total Keluar", "Saldo Register", "Jumlah Mutasi", "Mutasi Terakhir"],
    accounts.map((a) => [a.name, ACCOUNT_KIND_LABELS[a.kind as AccountKind], a.currency, a.status, a.totalIn, a.totalOut, a.balance, a.movementCount, a.lastMovementOn]));
  sheet(book, "Register Mutasi Kas", ["Tanggal", "Akun", "Mata Uang", "Jenis", "Arah", "Jumlah", "Pihak", "Catatan", "Jenis Sumber", "ID Sumber", "Pembalikan Dari", "Dicatat Pada"],
    [...registerMovements].sort((a, b) => String(a.occurred_on).localeCompare(String(b.occurred_on)) || String(a.id).localeCompare(String(b.id))).map((r) => [
      r.occurred_on, accountNames.get(String(r.account_id)) ?? "", r.currency, KIND_LABELS[r.kind as CashMovement["kind"]] ?? String(r.kind), r.direction === "out" ? "Keluar" : "Masuk",
      Number(r.amount), r.counterparty, r.memo, r.source_type, r.source_id, r.reversal_of, r.created_at]));
  if (cash && cashRows) {
    sheet(book, "Posisi Kas", ["Periode", "Mata Uang", "Pembayaran Masuk", "Pengembalian Dana", "Pengeluaran", "Selisih", "Pembayaran Tertunda/Gagal (tidak dihitung)"],
      cashRows.map((r) => [r.period, r.currency, r.paymentsIn, r.refundsOut, r.expensesOut, r.net, r.excludedPayments]));
    const totals = groupCashByCurrency(cashRows);
    sheet(book, "Catatan Kas", ["Keterangan", "Nilai"], [
      ["Periode kas", `${cash.period.from} s.d. ${cash.period.to} (zona waktu ${cash.timeZone})`],
      ["Sifat laporan", "Ringkasan baca-saja dari catatan pembayaran berhasil, pengembalian dana berhasil, dan pengeluaran. Bukan buku besar akuntansi."],
      ["Tidak termasuk", "Saldo awal, modal, transfer antar rekening, pajak, dan pembayaran payroll. Saldo awal dan modal yang dideklarasikan ada di sheet Register Akun Kas / Register Mutasi Kas dan tidak digabung dengan sheet ini."],
      ["Mata uang", "Setiap mata uang dihitung terpisah dan tidak pernah dijumlahkan."],
      ["Register kas", "Saldo register hanya jumlah mutasi yang dicatat pengguna per akun; bukan arus kas hasil pembayaran, bukan laba, dan tidak direkonsiliasi dengan bank."],
      ...totals.map((t) => [`Selisih ${t.currency}`, t.net]),
    ]);
  }
  return book;
}
