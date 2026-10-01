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

import { getAll, sheet } from "@/lib/homepaw-export";
import { loadPaymentRegister, type PaymentRegisterFilters } from "@/lib/payment-register";

export type FinanceExportFilters = Omit<PaymentRegisterFilters, "cursor" | "pageSize">;

// 100 pages * 200 rows/page = 20,000 payments per export — same bounded-cap
// style as homepaw-export.ts's getAll (49,500 rows), sized down because this
// loop pays one round trip per page instead of one per 500 rows.
const MAX_PAGES = 100;

async function loadAllPaymentRegisterRows(supabase: SupabaseClient, organizationId: string, filters: FinanceExportFilters) {
  const rows = [];
  let cursor: PaymentRegisterFilters["cursor"];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await loadPaymentRegister(supabase, organizationId, { ...filters, cursor, pageSize: 200 });
    rows.push(...result.rows);
    if (!result.hasMore || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return rows;
}

export async function buildFinanceExport(supabase: SupabaseClient, organizationId: string, filters: FinanceExportFilters): Promise<ExcelJS.Workbook> {
  const [paymentRows, expenses] = await Promise.all([
    loadAllPaymentRegisterRows(supabase, organizationId, filters),
    getAll(supabase, "expenses", organizationId, true),
  ]);
  const book = new ExcelJS.Workbook();
  book.creator = "Operro";
  sheet(book, "Pembayaran", ["Invoice", "Pelanggan", "Metode", "Jumlah", "Status", "Tahap Review", "Bulan Layanan", "Dibayar Pada", "Dikonfirmasi Oleh", "Divalidasi Oleh"],
    paymentRows.map((r) => [r.invoiceNumber, r.customerName, r.method, r.amount, r.status, r.stage, r.serviceMonth, r.paidAt, r.screenshotConfirmedBy, r.bankValidatedBy]));
  sheet(book, "Pengeluaran", ["Deskripsi", "Kategori", "Jumlah", "Status", "Terjadi Pada"],
    expenses.map((r) => [r.description, r.category, r.amount, r.status, r.incurred_at]));
  return book;
}
