/**
 * Section 30 — visit register: a read-side projection over completed
 * bookings (the "automatic" visit history) UNIONED with manual_visits (the
 * off-books case). This deliberately does NOT introduce a new table for the
 * booking half — see apps/web/src/app/customers/[customerId]/page.tsx:9-11
 * and the note at the top of 20260927100000_visit_register.sql: Operro has
 * one authoritative scheduling entity, and a visit register is a VIEW over
 * it, not a duplicate of it.
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

export interface VisitRegisterFilters {
  search?: string;
  customerId?: string;
  petId?: string;
  invoicedStatus?: InvoicedStatus | "all";
  sort?: "newest" | "oldest";
  /** "Automatically include completed bookings in the visit register." Off suppresses the booking-derived projection only; manual visits are unaffected. Defaults to true. */
  autoLogEnabled?: boolean;
}

function assertResult(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`visit_register_${scope}_failed:${error.message}`);
}

// ponytail: flat cap, not real pagination — raise it (or switch to a keyset
// query) if a single organization's visit history outgrows this. customerId
// and petId are pushed into the queries themselves specifically so THOSE
// filtered views are never truncated behind this cap regardless of how big
// the organization's total history gets.
const VISIT_REGISTER_ROW_CAP = 3000;

export async function loadVisitRegister(supabase: SupabaseClient, organizationId: string, filters: VisitRegisterFilters = {}): Promise<VisitRow[]> {
  // A pet filter is resolved to exact booking/manual-visit ids FIRST (bounded
  // by that pet's real visit count, not by VISIT_REGISTER_ROW_CAP) so it can
  // never be discarded behind the flat cap below (P4-class bug: comparing by
  // name was also a correctness bug — two pets can share a name).
  let petBookingIds: string[] | null = null;
  let petManualVisitIds: string[] | null = null;
  if (filters.petId) {
    const [gjpForPet, manualForPet] = await Promise.all([
      supabase.from("grooming_job_pets").select("grooming_job_id").eq("organization_id", organizationId).eq("pet_id", filters.petId).is("deleted_at", null),
      supabase.from("manual_visits").select("id").eq("organization_id", organizationId).eq("pet_id", filters.petId).is("deleted_at", null),
    ]);
    assertResult("pet_bookings", gjpForPet.error);
    assertResult("pet_manual_visits", manualForPet.error);
    petBookingIds = Array.from(new Set((gjpForPet.data ?? []).map((r) => r.grooming_job_id)));
    petManualVisitIds = (manualForPet.data ?? []).map((r) => r.id);
    if (petBookingIds.length === 0 && petManualVisitIds.length === 0) return [];
  }

  let bookingsQuery = supabase.from("bookings").select("id,branch_id,customer_id,fulfillment_mode,starts_at,status").eq("organization_id", organizationId).eq("status", "completed").is("deleted_at", null);
  let manualVisitsQuery = supabase.from("manual_visits").select("id,branch_id,customer_id,pet_id,fulfillment_mode,visit_at,description,invoice_id").eq("organization_id", organizationId).is("deleted_at", null);
  if (filters.customerId) { bookingsQuery = bookingsQuery.eq("customer_id", filters.customerId); manualVisitsQuery = manualVisitsQuery.eq("customer_id", filters.customerId); }
  if (petBookingIds) bookingsQuery = bookingsQuery.in("id", petBookingIds.length ? petBookingIds : ["00000000-0000-0000-0000-000000000000"]);
  if (petManualVisitIds) manualVisitsQuery = manualVisitsQuery.in("id", petManualVisitIds.length ? petManualVisitIds : ["00000000-0000-0000-0000-000000000000"]);

  const includeBookings = filters.autoLogEnabled !== false;
  const [bookings, manualVisits, customers] = await Promise.all([
    includeBookings ? bookingsQuery.order("starts_at", { ascending: false }).limit(VISIT_REGISTER_ROW_CAP) : Promise.resolve({ data: [] as { id: string; branch_id: string; customer_id: string; fulfillment_mode: string; starts_at: string; status: string }[], error: null }),
    manualVisitsQuery.order("visit_at", { ascending: false }).limit(VISIT_REGISTER_ROW_CAP),
    supabase.from("customers").select("id,display_name").eq("organization_id", organizationId).is("deleted_at", null),
  ]);
  assertResult("bookings", bookings.error);
  assertResult("manual_visits", manualVisits.error);
  assertResult("customers", customers.error);

  const customerMap = new Map((customers.data ?? []).map((c) => [c.id, c.display_name as string]));
  const bookingIds = (bookings.data ?? []).map((b) => b.id);
  const manualVisitIds = (manualVisits.data ?? []).map((v) => v.id);

  const [orders, gjp, billingBookings, billingManual] = await Promise.all([
    bookingIds.length ? supabase.from("orders").select("id,booking_id").eq("organization_id", organizationId).in("booking_id", bookingIds).neq("status", "canceled").is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    bookingIds.length ? supabase.from("grooming_job_pets").select("grooming_job_id,pet_id").eq("organization_id", organizationId).in("grooming_job_id", bookingIds).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    bookingIds.length ? supabase.from("visit_manual_billing").select("id,source_id,amount,note,billed_at").eq("organization_id", organizationId).eq("source_type", "booking").in("source_id", bookingIds).is("undone_at", null) : Promise.resolve({ data: [], error: null }),
    manualVisitIds.length ? supabase.from("visit_manual_billing").select("id,source_id,amount,note,billed_at").eq("organization_id", organizationId).eq("source_type", "manual_visit").in("source_id", manualVisitIds).is("undone_at", null) : Promise.resolve({ data: [], error: null }),
  ]);
  assertResult("orders", orders.error);
  assertResult("grooming_job_pets", gjp.error);
  assertResult("billing_bookings", billingBookings.error);
  assertResult("billing_manual", billingManual.error);

  // A booking is only really "invoiced" when its order resolved to a REAL,
  // non-void invoice — order existence alone (the previous check) claims
  // "invoiced" for a booking whose invoice was voided, and never surfaced
  // the invoice id/number at all (both bugs from the same root cause: no
  // invoice was ever actually looked up here).
  const orderIds = Array.from(new Set((orders.data ?? []).map((o) => o.id)));
  const orderInvoices = orderIds.length
    ? await supabase.from("invoices").select("id,invoice_number,order_id,status").eq("organization_id", organizationId).in("order_id", orderIds).neq("status", "void")
    : { data: [] as { id: string; invoice_number: string; order_id: string; status: string }[], error: null };
  assertResult("order_invoices", orderInvoices.error);
  const orderIdByBookingId = new Map((orders.data ?? []).map((o) => [o.booking_id, o.id]));
  const invoiceByOrderId = new Map((orderInvoices.data ?? []).map((i) => [i.order_id, i]));

  const petIds = Array.from(new Set([...(gjp.data ?? []).map((r) => r.pet_id), ...(manualVisits.data ?? []).map((v) => v.pet_id).filter((v): v is string => Boolean(v))]));
  const pets = petIds.length ? await supabase.from("pets").select("id,name").eq("organization_id", organizationId).in("id", petIds) : { data: [] as { id: string; name: string }[], error: null };
  assertResult("pets", pets.error);
  const petMap = new Map((pets.data ?? []).map((p) => [p.id, p.name]));

  const manualInvoiceIds = Array.from(new Set((manualVisits.data ?? []).map((v) => v.invoice_id).filter((v): v is string => Boolean(v))));
  const manualInvoices = manualInvoiceIds.length ? await supabase.from("invoices").select("id,invoice_number").eq("organization_id", organizationId).in("id", manualInvoiceIds) : { data: [] as { id: string; invoice_number: string }[], error: null };
  assertResult("invoices", manualInvoices.error);
  const invoiceMap = new Map((manualInvoices.data ?? []).map((i) => [i.id, i.invoice_number]));

  const bookingPetsMap = new Map<string, string[]>();
  const bookingPetIdsMap = new Map<string, string[]>();
  for (const row of gjp.data ?? []) {
    const name = petMap.get(row.pet_id) ?? "Hewan";
    bookingPetsMap.set(row.grooming_job_id, [...(bookingPetsMap.get(row.grooming_job_id) ?? []), name]);
    bookingPetIdsMap.set(row.grooming_job_id, [...(bookingPetIdsMap.get(row.grooming_job_id) ?? []), row.pet_id]);
  }
  const bookingBillingMap = new Map((billingBookings.data ?? []).map((b) => [b.source_id, b]));
  const manualBillingMap = new Map((billingManual.data ?? []).map((b) => [b.source_id, b]));

  const rows: VisitRow[] = [];
  for (const booking of bookings.data ?? []) {
    const billing = bookingBillingMap.get(booking.id);
    const orderId = orderIdByBookingId.get(booking.id);
    const invoice = orderId ? invoiceByOrderId.get(orderId) : undefined;
    rows.push({
      id: booking.id, sessionSource: "booking", branchId: booking.branch_id, customerId: booking.customer_id,
      customerName: customerMap.get(booking.customer_id) ?? "Pelanggan", petNames: bookingPetsMap.get(booking.id) ?? [], petIds: bookingPetIdsMap.get(booking.id) ?? [],
      fulfillmentMode: booking.fulfillment_mode, visitAt: booking.starts_at, description: "Booking selesai",
      invoicedStatus: invoice ? "invoiced" : billing ? "manually_billed" : "unbilled",
      invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.invoice_number ?? null,
      manualBilling: billing ? { id: billing.id, amount: Number(billing.amount), note: billing.note, billedAt: billing.billed_at } : null,
      canDelete: false,
    });
  }
  for (const visit of manualVisits.data ?? []) {
    const billing = manualBillingMap.get(visit.id);
    rows.push({
      id: visit.id, sessionSource: "manual", branchId: visit.branch_id, customerId: visit.customer_id,
      customerName: customerMap.get(visit.customer_id) ?? "Pelanggan", petNames: visit.pet_id && petMap.has(visit.pet_id) ? [petMap.get(visit.pet_id)!] : [], petIds: visit.pet_id ? [visit.pet_id] : [],
      fulfillmentMode: visit.fulfillment_mode, visitAt: visit.visit_at, description: visit.description,
      invoicedStatus: visit.invoice_id ? "invoiced" : billing ? "manually_billed" : "unbilled",
      invoiceId: visit.invoice_id, invoiceNumber: visit.invoice_id ? invoiceMap.get(visit.invoice_id) ?? null : null,
      manualBilling: billing ? { id: billing.id, amount: Number(billing.amount), note: billing.note, billedAt: billing.billed_at } : null,
      canDelete: !visit.invoice_id && !billing,
    });
  }

  let result = rows;
  if (filters.invoicedStatus && filters.invoicedStatus !== "all") result = result.filter((r) => r.invoicedStatus === filters.invoicedStatus);
  if (filters.search) {
    const needle = filters.search.trim().toLowerCase();
    if (needle) result = result.filter((r) => r.customerName.toLowerCase().includes(needle) || r.petNames.some((n) => n.toLowerCase().includes(needle)) || r.description.toLowerCase().includes(needle));
  }
  result.sort((a, b) => filters.sort === "oldest" ? a.visitAt.localeCompare(b.visitAt) : b.visitAt.localeCompare(a.visitAt));
  return result;
}
