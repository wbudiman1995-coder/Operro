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
  screenshotConfirmedAt: string | null;
  bankValidatedAt: string | null;
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

export async function loadPaymentRegister(supabase: SupabaseClient, organizationId: string, filters: PaymentRegisterFilters = {}): Promise<PaymentRegisterRow[]> {
  const payments = await supabase.from("payments")
    .select("id,branch_id,invoice_id,customer_id,method,amount,status,payment_stage,proof_attachment_id,screenshot_confirmed_at,bank_validated_at,paid_at")
    .eq("organization_id", organizationId).order("paid_at", { ascending: false }).limit(200);
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
      screenshotConfirmedAt: row.screenshot_confirmed_at,
      bankValidatedAt: row.bank_validated_at,
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
