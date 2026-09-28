/**
 * Section 29 — payment-control register: reads payments with their review
 * stage, invoice, customer, and service-month context. A focused file
 * (not folded into pilot-data.ts) because this is new surface, not an
 * extension of an existing loader.
 *
 * Filtering, service-month bucketing, and pagination all happen SERVER-SIDE
 * now, via app.search_payment_register / app.payment_register_stage_totals
 * (20261002100000_payment_visit_register_pagination.sql) — a prior pass
 * fixed this by raising the client-side row cap, which does not actually
 * fix "a filtered match can be discarded behind the cap": it just raises
 * the cap. Pagination is keyset (paid_at, id), not offset, since an offset
 * page can skip/duplicate rows as new payments land between loads.
 *
 * "Service month" uses the booking's actual visit date (via
 * invoice -> order -> booking.starts_at) in the branch's own timezone when
 * the invoice is booking-backed, and falls back to the invoice's issued_at
 * for package-sale invoices (which have no single visit date) — never
 * payment.paid_at, which is explicitly the wrong date per the brief. This
 * bucketing is now computed in the RPC itself (SQL to_char(...at time
 * zone...)), not in JS, so filtering by month is a real server-side
 * predicate, not a post-fetch filter.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type PaymentStage = "not_applicable" | "awaiting_screenshot" | "screenshot_confirmed" | "bank_validated" | "legacy_unreviewed";
export const PAYMENT_STAGES: PaymentStage[] = ["not_applicable", "awaiting_screenshot", "screenshot_confirmed", "bank_validated", "legacy_unreviewed"];

export interface PaymentRegisterRow {
  id: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  billingMode: string | null;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  method: string;
  amount: number;
  status: string;
  stage: PaymentStage;
  proofAttachmentId: string | null;
  proofUrl: string | null; // signed URL, 1h TTL; null when no proof or unreadable
  screenshotConfirmedAt: string | null;
  screenshotConfirmedBy: string | null; // display name/email of the confirming actor
  bankValidatedAt: string | null;
  bankValidatedBy: string | null;
  paidAt: string;
  serviceMonth: string; // "YYYY-MM" in the branch's own timezone
}

export interface PaymentRegisterCursor { paidAt: string; id: string }

export interface PaymentRegisterFilters {
  stage?: PaymentStage;
  serviceMonth?: string; // "YYYY-MM"
  search?: string; // matches invoice number or customer name, case-insensitive
  cursor?: PaymentRegisterCursor;
  pageSize?: number;
}

export type PaymentStageTotals = Record<PaymentStage, { amount: number; count: number }>;

export interface PaymentRegisterPage {
  rows: PaymentRegisterRow[];
  hasMore: boolean;
  nextCursor: PaymentRegisterCursor | null;
  /** Scoped by month/search, deliberately NOT by the selected stage — see payment-register.tsx. */
  stageTotals: PaymentStageTotals;
}

const DEFAULT_PAGE_SIZE = 25;

interface RegisterRpcRow {
  id: string; invoice_id: string | null; invoice_number: string | null; billing_mode: string | null;
  customer_id: string | null; customer_name: string; customer_phone: string | null;
  method: string; amount: number; status: string; payment_stage: PaymentStage;
  proof_attachment_id: string | null;
  screenshot_confirmed_at: string | null; screenshot_confirmed_by: string | null;
  bank_validated_at: string | null; bank_validated_by: string | null;
  paid_at: string; service_month: string;
}

export async function loadPaymentRegister(supabase: SupabaseClient, organizationId: string, filters: PaymentRegisterFilters = {}): Promise<PaymentRegisterPage> {
  void organizationId; // app.search_payment_register resolves the active org itself (app.fn_active_organization())
  const pageSize = Math.max(1, Math.min(filters.pageSize ?? DEFAULT_PAGE_SIZE, 200));

  const [pageResult, totalsResult] = await Promise.all([
    supabase.schema("app").rpc("search_payment_register", {
      p_stage: filters.stage ?? null,
      p_service_month: filters.serviceMonth ?? null,
      p_search: filters.search ?? null,
      p_cursor_paid_at: filters.cursor?.paidAt ?? null,
      p_cursor_id: filters.cursor?.id ?? null,
      // Fetch one extra row past the page to detect "more results exist"
      // without a separate count query.
      p_page_size: pageSize + 1,
    }),
    supabase.schema("app").rpc("payment_register_stage_totals", {
      p_service_month: filters.serviceMonth ?? null,
      p_search: filters.search ?? null,
    }),
  ]);
  if (pageResult.error) throw new Error(`payment_register_failed:${pageResult.error.message}`);
  if (totalsResult.error) throw new Error(`payment_register_failed:${totalsResult.error.message}`);

  const rawRows = (pageResult.data ?? []) as RegisterRpcRow[];
  const hasMore = rawRows.length > pageSize;
  const pageRows = hasMore ? rawRows.slice(0, pageSize) : rawRows;

  // Actor names for the review-stage timestamps, and a signed preview URL for
  // whatever proof is attached — bounded to THIS page only, now that the
  // register itself is paginated (previously enriched the entire capped set).
  const actorIds = Array.from(new Set(pageRows.flatMap((r) => [r.screenshot_confirmed_by, r.bank_validated_by]).filter((v): v is string => Boolean(v))));
  const proofAttachmentIds = Array.from(new Set(pageRows.map((r) => r.proof_attachment_id).filter((v): v is string => Boolean(v))));
  const [actors, proofAttachments] = await Promise.all([
    actorIds.length ? supabase.from("users").select("id,full_name,email").in("id", actorIds) : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string | null }[], error: null }),
    proofAttachmentIds.length ? supabase.from("attachments").select("id,storage_path").in("id", proofAttachmentIds) : Promise.resolve({ data: [] as { id: string; storage_path: string }[], error: null }),
  ]);
  if (actors.error) throw new Error(`payment_register_failed:${actors.error.message}`);
  if (proofAttachments.error) throw new Error(`payment_register_failed:${proofAttachments.error.message}`);
  const actorName = new Map((actors.data ?? []).map((u) => [u.id, u.full_name || u.email || "Pengguna"]));
  const proofPathById = new Map((proofAttachments.data ?? []).map((a) => [a.id, a.storage_path]));
  let proofUrlById = new Map<string, string>();
  if (proofAttachments.data?.length) {
    // Deleted/unreadable proofs are handled honestly: createSignedUrls
    // reports a per-path error instead of throwing, and a missing entry
    // here just means proofUrl stays null for that row.
    const signed = await supabase.storage.from("attachments").createSignedUrls(proofAttachments.data.map((a) => a.storage_path), 3600);
    if (!signed.error) proofUrlById = new Map((signed.data ?? []).flatMap((s) => (s.signedUrl ? [[s.path ?? "", s.signedUrl]] : [])));
  }

  const rows: PaymentRegisterRow[] = pageRows.map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    billingMode: row.billing_mode,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    method: row.method,
    amount: Number(row.amount),
    status: row.status,
    stage: row.payment_stage,
    proofAttachmentId: row.proof_attachment_id,
    proofUrl: row.proof_attachment_id ? (proofUrlById.get(proofPathById.get(row.proof_attachment_id) ?? "") ?? null) : null,
    screenshotConfirmedAt: row.screenshot_confirmed_at,
    screenshotConfirmedBy: row.screenshot_confirmed_by ? (actorName.get(row.screenshot_confirmed_by) ?? null) : null,
    bankValidatedAt: row.bank_validated_at,
    bankValidatedBy: row.bank_validated_by ? (actorName.get(row.bank_validated_by) ?? null) : null,
    paidAt: row.paid_at,
    serviceMonth: row.service_month,
  }));

  const stageTotals = Object.fromEntries(PAYMENT_STAGES.map((stage) => [stage, { amount: 0, count: 0 }])) as PaymentStageTotals;
  for (const row of (totalsResult.data ?? []) as Array<{ payment_stage: PaymentStage; total_amount: number; row_count: number }>) {
    stageTotals[row.payment_stage] = { amount: Number(row.total_amount), count: Number(row.row_count) };
  }

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? { paidAt: last.paid_at, id: last.id } : null;

  return { rows, hasMore, nextCursor, stageTotals };
}
