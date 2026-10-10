/**
 * Function index:
 * - loadUnbilledVisits / loadInvoicePaymentIssues / scanPayrollSources: read-only discrepancy loaders over the
 *   reconcile_* RPCs (20261029150000). They never repair, create, void or re-link anything.
 * - ISSUE_COPY: plain-language explanation for every discrepancy kind, including what the system will NOT do.
 *
 * A discrepancy is a fact worth a human look, not a verdict: "paid in full but still issued" may be a timing gap,
 * "source reduced" may be a legitimate void. The page says so and offers no repair button.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type InvoiceIssue = "paid_in_full_not_closed" | "closed_without_full_payment" | "void_with_payments" | "currency_mismatch";
export type PayrollIssue = "source_reduced" | "source_unavailable" | "snapshot_without_counts";

export const ISSUE_COPY: Record<InvoiceIssue | PayrollIssue, { title: string; detail: string }> = {
  paid_in_full_not_closed: { title: "Lunas tetapi invoice masih terbit", detail: "Pembayaran valid (dikurangi refund) sudah menutup total, namun status invoice belum lunas." },
  closed_without_full_payment: { title: "Berstatus lunas tetapi pembayaran kurang", detail: "Invoice lunas, sementara pembayaran valid dikurangi refund lebih kecil dari total." },
  void_with_payments: { title: "Invoice dibatalkan tetapi masih ada uang masuk", detail: "Ada pembayaran valid yang belum dikembalikan untuk invoice yang sudah dibatalkan." },
  currency_mismatch: { title: "Mata uang pembayaran berbeda", detail: "Ada pembayaran valid dalam mata uang lain dari invoice; jumlahnya tidak dijumlahkan lintas mata uang." },
  source_reduced: { title: "Sumber payroll berkurang setelah dipublikasikan", detail: "Pekerjaan yang valid saat ini lebih sedikit daripada yang tercatat di snapshot (invoice dibatalkan atau pekerjaan dihapus). Snapshot tidak diubah." },
  source_unavailable: { title: "Sumber payroll tidak dapat dihitung ulang", detail: "Perhitungan ulang dari data sumber gagal; periksa data staf dan pekerjaan secara manual." },
  snapshot_without_counts: { title: "Snapshot lama tanpa hitungan sumber", detail: "Snapshot ini dibuat sebelum hitungan sumber disimpan, sehingga tidak dapat dibandingkan. Tidak ada kesimpulan yang dibuat." },
};

export interface UnbilledVisit { id: string; source: "booking" | "manual"; branchId: string; customerId: string; customerName: string; visitAt: string; description: string }
export interface InvoiceIssueRow {
  invoiceId: string; invoiceNumber: string; customerName: string; branchId: string; status: string; currency: string; total: number;
  paidAmount: number; refundedAmount: number; netPaid: number; foreignCurrencyPayments: number; issue: InvoiceIssue; issuedAt: string;
}
export interface PayrollIssueRow {
  itemId: string; runId: string; periodStart: string; periodEnd: string; runStatus: string; staffName: string; issue: PayrollIssue;
  snapshot: { basic: number | null; styling: number | null; botak: number | null }; live: { basic: number | null; styling: number | null; botak: number | null };
}
export interface PageOf<T, C> { rows: T[]; hasMore: boolean; nextCursor: C | null }

function fail(scope: string, error: { code?: string; message: string }): never {
  throw new Error(`reconcile_${scope}_failed:${error.code ?? ""}:${error.message}`);
}

export async function loadUnbilledVisits(supabase: SupabaseClient, cursor: { visitAt: string; id: string } | null, pageSize = 25): Promise<PageOf<UnbilledVisit, { visitAt: string; id: string }>> {
  const { data, error } = await supabase.schema("app").rpc("reconcile_unbilled_visits", { p_after_visit: cursor?.visitAt ?? null, p_after_id: cursor?.id ?? null, p_limit: pageSize + 1 });
  if (error) fail("visits", error);
  const all = (data ?? []) as Array<{ id: string; session_source: "booking" | "manual"; branch_id: string; customer_id: string; customer_name: string; visit_at: string; description: string }>;
  const hasMore = all.length > pageSize;
  const page = hasMore ? all.slice(0, pageSize) : all;
  const last = page[page.length - 1];
  return {
    rows: page.map((row) => ({ id: row.id, source: row.session_source, branchId: row.branch_id, customerId: row.customer_id, customerName: row.customer_name, visitAt: row.visit_at, description: row.description })),
    hasMore, nextCursor: hasMore && last ? { visitAt: last.visit_at, id: last.id } : null,
  };
}

export async function loadInvoicePaymentIssues(supabase: SupabaseClient, cursor: { issuedAt: string; id: string } | null, pageSize = 25): Promise<PageOf<InvoiceIssueRow, { issuedAt: string; id: string }>> {
  const { data, error } = await supabase.schema("app").rpc("reconcile_invoice_payments", { p_after_issued: cursor?.issuedAt ?? null, p_after_id: cursor?.id ?? null, p_limit: pageSize + 1 });
  if (error) fail("invoices", error);
  const all = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = all.length > pageSize;
  const page = hasMore ? all.slice(0, pageSize) : all;
  const last = page[page.length - 1];
  return {
    rows: page.map((row) => ({
      invoiceId: String(row.invoice_id), invoiceNumber: String(row.invoice_number), customerName: String(row.customer_name), branchId: String(row.branch_id),
      status: String(row.status), currency: String(row.currency), total: Number(row.total), paidAmount: Number(row.paid_amount),
      refundedAmount: Number(row.refunded_amount), netPaid: Number(row.net_paid), foreignCurrencyPayments: Number(row.foreign_currency_payments),
      issue: row.issue as InvoiceIssue, issuedAt: String(row.issued_at),
    })),
    hasMore, nextCursor: hasMore && last ? { issuedAt: String(last.issued_at), id: String(last.invoice_id) } : null,
  };
}

export interface PayrollScan { rows: PayrollIssueRow[]; scannedThrough: string | null; hasMore: boolean }
export async function scanPayrollSources(supabase: SupabaseClient, after: string | null, scan = 25): Promise<PayrollScan> {
  const { data, error } = await supabase.schema("app").rpc("reconcile_payroll_sources", { p_after_item: after, p_scan: scan });
  if (error) fail("payroll", error);
  const all = (data ?? []) as Array<Record<string, unknown>>;
  const first = all[0];
  const n = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    rows: all.filter((row) => row.item_id).map((row) => ({
      itemId: String(row.item_id), runId: String(row.run_id), periodStart: String(row.period_start), periodEnd: String(row.period_end), runStatus: String(row.run_status),
      staffName: String(row.staff_name), issue: row.issue as PayrollIssue,
      snapshot: { basic: n(row.snapshot_basic), styling: n(row.snapshot_styling), botak: n(row.snapshot_botak) },
      live: { basic: n(row.live_basic), styling: n(row.live_styling), botak: n(row.live_botak) },
    })),
    scannedThrough: first && first.scanned_through ? String(first.scanned_through) : null,
    hasMore: first ? Boolean(first.has_more) : false,
  };
}
