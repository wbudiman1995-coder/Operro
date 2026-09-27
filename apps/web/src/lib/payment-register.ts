/**
 * Section 29 — payment-control register: reads payments with their review
 * stage, invoice, customer, and service-month context. A focused file
 * (not folded into pilot-data.ts) because this is new surface, not an
 * extension of an existing loader.
 *
 * "Service month" uses the booking's actual visit date (via
 * invoice -> order -> booking.starts_at) in the branch's own timezone when
 * the invoice is booking-backed, and falls back to the invoice's issued_at
 * for package-sale invoices (which have no single visit date) — never
 * payment.paid_at, which is explicitly the wrong date per the brief.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type PaymentStage = "not_applicable" | "awaiting_screenshot" | "screenshot_confirmed" | "bank_validated" | "legacy_unreviewed";

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

export interface PaymentRegisterFilters {
  stage?: PaymentStage;
  serviceMonth?: string; // "YYYY-MM"
  search?: string; // matches invoice number or customer name, case-insensitive
}

function monthKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

// All filtering (stage/month/search) happens client-side in PaymentRegister
// over this ENTIRE loaded set, so the cap below must never be low enough to
// silently hide a match from a filtered view (P4 finding: the previous
// limit(200) discarded rows BEFORE the client ever got to filter them).
// ponytail: flat cap, not real pagination — raise it (or switch to a keyset
// query) if a single organization's payment history outgrows this.
const PAYMENT_REGISTER_ROW_CAP = 5000;

export async function loadPaymentRegister(supabase: SupabaseClient, organizationId: string, filters: PaymentRegisterFilters = {}): Promise<PaymentRegisterRow[]> {
  let paymentsQuery = supabase.from("payments")
    .select("id,branch_id,invoice_id,customer_id,method,amount,status,payment_stage,proof_attachment_id,screenshot_confirmed_at,screenshot_confirmed_by,bank_validated_at,bank_validated_by,paid_at")
    .eq("organization_id", organizationId);
  if (filters.stage) paymentsQuery = paymentsQuery.eq("payment_stage", filters.stage);
  const payments = await paymentsQuery.order("paid_at", { ascending: false }).limit(PAYMENT_REGISTER_ROW_CAP);
  if (payments.error) throw new Error(`payment_register_failed:${payments.error.message}`);
  const rows = payments.data ?? [];

  const [branches, invoices, customers] = await Promise.all([
    supabase.from("branches").select("id,timezone").eq("organization_id", organizationId),
    supabase.from("invoices").select("id,invoice_number,billing_mode,order_id,issued_at").eq("organization_id", organizationId)
      .in("id", Array.from(new Set(rows.map((r) => r.invoice_id).filter((v): v is string => Boolean(v)))).length ? Array.from(new Set(rows.map((r) => r.invoice_id).filter((v): v is string => Boolean(v)))) : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from("customers").select("id,display_name,phone").eq("organization_id", organizationId),
  ]);
  if (branches.error) throw new Error(`payment_register_failed:${branches.error.message}`);
  if (invoices.error) throw new Error(`payment_register_failed:${invoices.error.message}`);
  if (customers.error) throw new Error(`payment_register_failed:${customers.error.message}`);

  const branchTz = new Map((branches.data ?? []).map((b) => [b.id, b.timezone || "Asia/Jakarta"]));
  const invoiceMap = new Map((invoices.data ?? []).map((i) => [i.id, i]));
  const customerMap = new Map((customers.data ?? []).map((c) => [c.id, c]));

  const orderIds = Array.from(new Set(Array.from(invoiceMap.values()).map((i) => i.order_id).filter((v): v is string => Boolean(v))));
  const orders = orderIds.length
    ? await supabase.from("orders").select("id,booking_id").eq("organization_id", organizationId).in("id", orderIds)
    : { data: [] as { id: string; booking_id: string | null }[], error: null };
  if (orders.error) throw new Error(`payment_register_failed:${orders.error.message}`);
  const orderBookingMap = new Map((orders.data ?? []).map((o) => [o.id, o.booking_id]));

  const bookingIds = Array.from(new Set(Array.from(orderBookingMap.values()).filter((v): v is string => Boolean(v))));
  const bookings = bookingIds.length
    ? await supabase.from("bookings").select("id,starts_at").eq("organization_id", organizationId).in("id", bookingIds)
    : { data: [] as { id: string; starts_at: string }[], error: null };
  if (bookings.error) throw new Error(`payment_register_failed:${bookings.error.message}`);
  const bookingStartMap = new Map((bookings.data ?? []).map((b) => [b.id, b.starts_at]));

  // Actor names for the review-stage timestamps, and a signed preview URL for
  // whatever proof is attached — a reviewer must be able to inspect the proof
  // before confirming/validating, not just see that "something" was uploaded.
  const actorIds = Array.from(new Set(rows.flatMap((r) => [r.screenshot_confirmed_by, r.bank_validated_by]).filter((v): v is string => Boolean(v))));
  const proofAttachmentIds = Array.from(new Set(rows.map((r) => r.proof_attachment_id).filter((v): v is string => Boolean(v))));
  const [actors, proofAttachments] = await Promise.all([
    actorIds.length ? supabase.from("users").select("id,full_name,email").in("id", actorIds) : { data: [] as { id: string; full_name: string | null; email: string | null }[], error: null },
    proofAttachmentIds.length ? supabase.from("attachments").select("id,storage_path").eq("organization_id", organizationId).in("id", proofAttachmentIds) : { data: [] as { id: string; storage_path: string }[], error: null },
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

  let result: PaymentRegisterRow[] = rows.map((row) => {
    const invoice = row.invoice_id ? invoiceMap.get(row.invoice_id) : undefined;
    const customer = row.customer_id ? customerMap.get(row.customer_id) : undefined;
    const tz = branchTz.get(row.branch_id) ?? "Asia/Jakarta";
    const bookingStart = invoice?.order_id ? bookingStartMap.get(orderBookingMap.get(invoice.order_id) ?? "") : undefined;
    const serviceDate = bookingStart ?? invoice?.issued_at ?? row.paid_at;
    return {
      id: row.id,
      invoiceId: row.invoice_id,
      invoiceNumber: invoice?.invoice_number ?? null,
      billingMode: invoice?.billing_mode ?? null,
      customerId: row.customer_id,
      customerName: customer?.display_name ?? "Pelanggan",
      customerPhone: customer?.phone ?? null,
      method: row.method,
      amount: Number(row.amount),
      status: row.status,
      stage: row.payment_stage as PaymentStage,
      proofAttachmentId: row.proof_attachment_id,
      proofUrl: row.proof_attachment_id ? (proofUrlById.get(proofPathById.get(row.proof_attachment_id) ?? "") ?? null) : null,
      screenshotConfirmedAt: row.screenshot_confirmed_at,
      screenshotConfirmedBy: row.screenshot_confirmed_by ? (actorName.get(row.screenshot_confirmed_by) ?? null) : null,
      bankValidatedAt: row.bank_validated_at,
      bankValidatedBy: row.bank_validated_by ? (actorName.get(row.bank_validated_by) ?? null) : null,
      paidAt: row.paid_at,
      serviceMonth: monthKey(serviceDate, tz),
    };
  });

  if (filters.stage) result = result.filter((r) => r.stage === filters.stage);
  if (filters.serviceMonth) result = result.filter((r) => r.serviceMonth === filters.serviceMonth);
  if (filters.search) {
    const needle = filters.search.trim().toLowerCase();
    if (needle) result = result.filter((r) => r.invoiceNumber?.toLowerCase().includes(needle) || r.customerName.toLowerCase().includes(needle));
  }
  return result;
}
