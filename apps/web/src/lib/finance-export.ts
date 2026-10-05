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

export async function buildFinanceExport(supabase: SupabaseClient, organizationId: string, filters: FinanceExportFilters): Promise<ExcelJS.Workbook> {
  const [paymentRows, expenses] = await Promise.all([
    loadAllPaymentRegisterRows(supabase, organizationId, filters),
    getAll(supabase, "expenses", organizationId, true),
  ]);
  const paymentCurrencies = await loadPaymentCurrencies(supabase, organizationId, paymentRows.map((row) => row.id));
  const book = new ExcelJS.Workbook();
  book.creator = "Operro";
  sheet(book, "Pembayaran", ["Invoice", "Pelanggan", "Metode", "Jumlah", "Mata Uang", "Status", "Tahap Review", "Bulan Layanan", "Dibayar Pada", "Dikonfirmasi Oleh", "Divalidasi Oleh"],
    paymentRows.map((r) => [r.invoiceNumber, r.customerName, r.method, r.amount, paymentCurrencies.get(r.id) ?? "", r.status, r.stage, r.serviceMonth, r.paidAt, r.screenshotConfirmedBy, r.bankValidatedBy]));
  sheet(book, "Pengeluaran - Semua", ["Deskripsi", "Kategori", "Jumlah", "Mata Uang", "Status", "Terjadi Pada"],
    expenses.map((r) => [r.description, r.category, r.amount, r.currency, r.status, r.incurred_at]));
  return book;
}
