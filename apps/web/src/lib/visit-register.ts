/**
 * Section 30 — visit register: a read-side projection over completed
 * bookings (the "automatic" visit history) UNIONED with manual_visits (the
 * off-books case). This deliberately does NOT introduce a new table for the
 * booking half — see apps/web/src/app/customers/[customerId]/page.tsx:9-11
 * and the note at the top of 20260927100000_visit_register.sql: Operro has
 * one authoritative scheduling entity, and a visit register is a VIEW over
 * it, not a duplicate of it.
 *
 * All filtering/sorting/pagination happens SERVER-SIDE via
 * app.search_visit_register (20261002100000_payment_visit_register_pagination.sql)
 * — a prior pass fixed correctness bugs (real invoice resolution, pet-ID
 * filtering) but still fetched a capped, unfiltered-by-customer/search
 * snapshot into the browser and filtered it there. Pagination is keyset
 * (visit_at, id), not offset, for the same reason as the payment register.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type SessionSource = "booking" | "manual";
export type InvoicedStatus = "invoiced" | "manually_billed" | "unbilled";

export interface VisitRow {
  id: string; // booking id or manual_visits id
  sessionSource: SessionSource;
  branchId: string;
  customerId: string;
  customerName: string;
  petNames: string[];
  petIds: string[];
  fulfillmentMode: string;
  visitAt: string;
  description: string;
  invoicedStatus: InvoicedStatus;
  invoiceId: string | null;
  invoiceNumber: string | null;
  manualBilling: { id: string; amount: number; note: string | null; billedAt: string } | null;
  canDelete: boolean; // manual visits only, and only when safe (no invoice/billing)
}

export interface VisitRegisterCursor { visitAt: string; id: string }

export interface VisitRegisterFilters {
  search?: string;
  customerId?: string;
  petId?: string;
  invoicedStatus?: InvoicedStatus | "all";
  sort?: "newest" | "oldest";
  /** "Automatically include completed bookings in the visit register." Off suppresses the booking-derived projection only; manual visits are unaffected. Defaults to true. */
  autoLogEnabled?: boolean;
  cursor?: VisitRegisterCursor;
  pageSize?: number;
}

export interface VisitRegisterPage {
  rows: VisitRow[];
  hasMore: boolean;
  nextCursor: VisitRegisterCursor | null;
}

const DEFAULT_PAGE_SIZE = 25;

interface RegisterRpcRow {
  id: string; session_source: SessionSource; branch_id: string; customer_id: string; customer_name: string;
  pet_names: string[]; pet_ids: string[]; fulfillment_mode: string; visit_at: string; description: string;
  invoiced_status: InvoicedStatus; invoice_id: string | null; invoice_number: string | null;
  manual_billing_id: string | null; manual_billing_amount: number | null; manual_billing_note: string | null; manual_billing_billed_at: string | null;
  can_delete: boolean;
}

export async function loadVisitRegister(supabase: SupabaseClient, organizationId: string, filters: VisitRegisterFilters = {}): Promise<VisitRegisterPage> {
  void organizationId; // app.search_visit_register resolves the active org itself (app.fn_active_organization())
  const pageSize = Math.max(1, Math.min(filters.pageSize ?? DEFAULT_PAGE_SIZE, 200));
  const sort = filters.sort ?? "newest";

  const result = await supabase.schema("app").rpc("search_visit_register", {
    p_customer_id: filters.customerId ?? null,
    p_pet_id: filters.petId ?? null,
    p_invoiced_status: filters.invoicedStatus ?? null,
    p_search: filters.search ?? null,
    p_include_bookings: filters.autoLogEnabled !== false,
    p_sort: sort,
    p_cursor_visit_at: filters.cursor?.visitAt ?? null,
    p_cursor_id: filters.cursor?.id ?? null,
    // Fetch one extra row past the page to detect "more results exist"
    // without a separate count query.
    p_page_size: pageSize + 1,
  });
  if (result.error) throw new Error(`visit_register_failed:${result.error.message}`);

  const rawRows = (result.data ?? []) as RegisterRpcRow[];
  const hasMore = rawRows.length > pageSize;
  const pageRows = hasMore ? rawRows.slice(0, pageSize) : rawRows;

  const rows: VisitRow[] = pageRows.map((row) => ({
    id: row.id,
    sessionSource: row.session_source,
    branchId: row.branch_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    petNames: row.pet_names ?? [],
    petIds: row.pet_ids ?? [],
    fulfillmentMode: row.fulfillment_mode,
    visitAt: row.visit_at,
    description: row.description,
    invoicedStatus: row.invoiced_status,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    manualBilling: row.manual_billing_id ? { id: row.manual_billing_id, amount: Number(row.manual_billing_amount), note: row.manual_billing_note, billedAt: row.manual_billing_billed_at as string } : null,
    canDelete: row.can_delete,
  }));

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? { visitAt: last.visit_at, id: last.id } : null;

  return { rows, hasMore, nextCursor };
}
