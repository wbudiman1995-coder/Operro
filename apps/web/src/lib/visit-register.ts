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
}

function assertResult(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`visit_register_${scope}_failed:${error.message}`);
}

export async function loadVisitRegister(supabase: SupabaseClient, organizationId: string, filters: VisitRegisterFilters = {}): Promise<VisitRow[]> {
  const [bookings, manualVisits, customers] = await Promise.all([
    supabase.from("bookings").select("id,branch_id,customer_id,fulfillment_mode,starts_at,status").eq("organization_id", organizationId).eq("status", "completed").is("deleted_at", null).order("starts_at", { ascending: false }).limit(300),
    supabase.from("manual_visits").select("id,branch_id,customer_id,pet_id,fulfillment_mode,visit_at,description,invoice_id").eq("organization_id", organizationId).is("deleted_at", null).order("visit_at", { ascending: false }).limit(300),
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

  const petIds = Array.from(new Set([...(gjp.data ?? []).map((r) => r.pet_id), ...(manualVisits.data ?? []).map((v) => v.pet_id).filter((v): v is string => Boolean(v))]));
  const pets = petIds.length ? await supabase.from("pets").select("id,name").eq("organization_id", organizationId).in("id", petIds) : { data: [] as { id: string; name: string }[], error: null };
  assertResult("pets", pets.error);
  const petMap = new Map((pets.data ?? []).map((p) => [p.id, p.name]));

  const invoiceIds = Array.from(new Set((manualVisits.data ?? []).map((v) => v.invoice_id).filter((v): v is string => Boolean(v))));
  const invoices = invoiceIds.length ? await supabase.from("invoices").select("id,invoice_number").eq("organization_id", organizationId).in("id", invoiceIds) : { data: [] as { id: string; invoice_number: string }[], error: null };
  assertResult("invoices", invoices.error);
  const invoiceMap = new Map((invoices.data ?? []).map((i) => [i.id, i.invoice_number]));

  const bookingPetsMap = new Map<string, string[]>();
  for (const row of gjp.data ?? []) {
    const name = petMap.get(row.pet_id) ?? "Hewan";
    bookingPetsMap.set(row.grooming_job_id, [...(bookingPetsMap.get(row.grooming_job_id) ?? []), name]);
  }
  const activeOrderBookingIds = new Set((orders.data ?? []).map((o) => o.booking_id));
  const bookingBillingMap = new Map((billingBookings.data ?? []).map((b) => [b.source_id, b]));
  const manualBillingMap = new Map((billingManual.data ?? []).map((b) => [b.source_id, b]));

  const rows: VisitRow[] = [];
  for (const booking of bookings.data ?? []) {
    const billing = bookingBillingMap.get(booking.id);
    const invoiced = activeOrderBookingIds.has(booking.id);
    rows.push({
      id: booking.id, sessionSource: "booking", branchId: booking.branch_id, customerId: booking.customer_id,
      customerName: customerMap.get(booking.customer_id) ?? "Pelanggan", petNames: bookingPetsMap.get(booking.id) ?? [],
      fulfillmentMode: booking.fulfillment_mode, visitAt: booking.starts_at, description: "Booking selesai",
      invoicedStatus: invoiced ? "invoiced" : billing ? "manually_billed" : "unbilled",
      invoiceId: null, invoiceNumber: null,
      manualBilling: billing ? { id: billing.id, amount: Number(billing.amount), note: billing.note, billedAt: billing.billed_at } : null,
      canDelete: false,
    });
  }
  for (const visit of manualVisits.data ?? []) {
    const billing = manualBillingMap.get(visit.id);
    rows.push({
      id: visit.id, sessionSource: "manual", branchId: visit.branch_id, customerId: visit.customer_id,
      customerName: customerMap.get(visit.customer_id) ?? "Pelanggan", petNames: visit.pet_id && petMap.has(visit.pet_id) ? [petMap.get(visit.pet_id)!] : [],
      fulfillmentMode: visit.fulfillment_mode, visitAt: visit.visit_at, description: visit.description,
      invoicedStatus: visit.invoice_id ? "invoiced" : billing ? "manually_billed" : "unbilled",
      invoiceId: visit.invoice_id, invoiceNumber: visit.invoice_id ? invoiceMap.get(visit.invoice_id) ?? null : null,
      manualBilling: billing ? { id: billing.id, amount: Number(billing.amount), note: billing.note, billedAt: billing.billed_at } : null,
      canDelete: !visit.invoice_id && !billing,
    });
  }

  let result = rows;
  if (filters.customerId) result = result.filter((r) => r.customerId === filters.customerId);
  if (filters.petId) result = result.filter((r) => r.petNames.length === 0 ? false : petMap.get(filters.petId!) ? r.petNames.includes(petMap.get(filters.petId!)!) : false);
  if (filters.invoicedStatus && filters.invoicedStatus !== "all") result = result.filter((r) => r.invoicedStatus === filters.invoicedStatus);
  if (filters.search) {
    const needle = filters.search.trim().toLowerCase();
    if (needle) result = result.filter((r) => r.customerName.toLowerCase().includes(needle) || r.petNames.some((n) => n.toLowerCase().includes(needle)) || r.description.toLowerCase().includes(needle));
  }
  result.sort((a, b) => filters.sort === "oldest" ? a.visitAt.localeCompare(b.visitAt) : b.visitAt.localeCompare(a.visitAt));
  return result;
}
