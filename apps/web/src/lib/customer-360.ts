/**
 * Function index:
 * - loadCustomerOverview: loads the profile header, per-currency spend, and pet roster.
 * - loadCustomerBookings: loads recent bookings with pets and snapshot services.
 * - loadCustomerInvoices: loads issued invoices and recorded payments.
 * - loadCustomerPackages: loads ledger-backed package balances.
 * - loadCustomerHistory: loads read-only timeline events for the customer and its pets.
 * - visibleCustomer360Tabs: hides tabs the caller has no permission to read.
 *
 * All loaders are bounded and organization-scoped. There is no photo/evidence surface:
 * grooming evidence is deferred to Batch 2, on `attachments` with private storage.
 *
 * Timestamps: every date is formatted in the time zone of the branch that owns the record,
 * resolved through `branch-context`. Nothing here calls `Intl.DateTimeFormat` without an
 * explicit `timeZone`, because omitting it silently uses the server process zone.
 *
 * History source: `app.audit_log` is NOT read. It lives in the `app` schema and no
 * migration enables row level security or defines a policy on it, so it is not a safe
 * client-readable source. `public.timeline_events` is the supported read-only history.
 *
 * Currency: payments are grouped by currency and never summed across currencies. The
 * schema stores a currency per payment, so one total under one label would be a fiction.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CapabilityMap } from "@/lib/authorization";
import { ageLabelFromBirthdate, readCustomFields, readMedicalFlags, sizeBandForWeight, type GroomingSizeBand } from "@/lib/grooming-profile";

function assertResult(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`${scope}_failed:${error.message}`);
}

function relationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

export const CUSTOMER_BOOKING_LIMIT = 40;
export const CUSTOMER_INVOICE_LIMIT = 40;
export const CUSTOMER_HISTORY_LIMIT = 60;
export const CUSTOMER_PAYMENT_LIMIT = 500;

export const CUSTOMER_360_TABS = ["pets", "bookings", "invoices", "packages", "notes", "history"] as const;
export type Customer360Tab = (typeof CUSTOMER_360_TABS)[number];

export const CUSTOMER_360_TAB_LABELS: Record<Customer360Tab, string> = {
  pets: "Hewan",
  bookings: "Booking",
  invoices: "Invoice",
  packages: "Paket",
  notes: "Catatan",
  history: "Riwayat",
};

/** Permission required to read each tab, or null when membership alone is sufficient. */
export const CUSTOMER_360_TAB_CAPABILITY: Record<Customer360Tab, keyof CapabilityMap | null> = {
  pets: null,
  bookings: "booking.read",
  invoices: "finance.read",
  packages: "membership.read",
  notes: null,
  history: null,
};

export function parseCustomer360Tab(value: unknown): Customer360Tab {
  return CUSTOMER_360_TABS.includes(value as Customer360Tab) ? (value as Customer360Tab) : "pets";
}

export function visibleCustomer360Tabs(capabilities: CapabilityMap): Customer360Tab[] {
  return CUSTOMER_360_TABS.filter((tab) => {
    const required = CUSTOMER_360_TAB_CAPABILITY[tab];
    return required === null || capabilities[required];
  });
}

export function isCustomer360TabPermitted(tab: Customer360Tab, capabilities: CapabilityMap): boolean {
  const required = CUSTOMER_360_TAB_CAPABILITY[tab];
  return required === null || capabilities[required];
}

export interface CustomerPetProfile {
  id: string;
  name: string;
  species: string;
  breed: string | null;
  sex: string;
  ageLabel: string | null;
  weightKg: number | null;
  sizeBand: GroomingSizeBand | null;
  color: string | null;
  temperament: string | null;
  notes: string | null;
  status: string;
  medicalFlags: string[];
  customFields: Array<{ label: string; value: string }>;
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface CustomerOverview {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  notes: string | null;
  addressLine: string | null;
  mapsUrl: string | null;
  /** One entry per currency. Null when the caller lacks `finance.read`. */
  spendByCurrency: CurrencyTotal[] | null;
  spendCapped: boolean;
  pets: CustomerPetProfile[];
}

function readAddressLine(address: unknown): string | null {
  if (typeof address !== "object" || address === null || Array.isArray(address)) return null;
  const record = address as Record<string, unknown>;
  const parts = ["line1", "line2", "district", "city", "province", "postal_code"].flatMap((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Groups payment amounts by currency, largest first. Never adds across currencies. */
export function groupTotalsByCurrency(
  rows: readonly { amount: number | string; currency: string | null }[],
): CurrencyTotal[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = row.currency && row.currency.length > 0 ? row.currency : "UNKNOWN";
    totals.set(currency, (totals.get(currency) ?? 0) + Number(row.amount));
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
}

export async function loadCustomerOverview(
  supabase: SupabaseClient,
  organizationId: string,
  customerId: string,
  capabilities: CapabilityMap,
): Promise<CustomerOverview | null> {
  const customerResult = await supabase
    .from("customers")
    .select("id,display_name,status,phone,email,source,notes,address,latitude,longitude")
    .eq("organization_id", organizationId)
    .eq("id", customerId)
    .is("deleted_at", null)
    .maybeSingle();
  assertResult("customer_overview", customerResult.error);
  const customer = customerResult.data;
  if (!customer) return null;

  const [petResult, paymentResult] = await Promise.all([
    supabase
      .from("pets")
      .select("id,name,species,breed,sex,birthdate,weight_kg,color,temperament,notes,status,medical_flags,metadata")
      .eq("organization_id", organizationId)
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .order("name"),
    // Skipped entirely without finance.read, so the header can say "restricted" rather
    // than rendering an RLS-emptied result as a zero balance.
    capabilities["finance.read"]
      ? supabase
          .from("payments")
          .select("amount,currency")
          .eq("organization_id", organizationId)
          .eq("customer_id", customerId)
          .eq("status", "succeeded")
          .limit(CUSTOMER_PAYMENT_LIMIT + 1)
      : Promise.resolve({ data: null, error: null }),
  ]);
  assertResult("customer_pets", petResult.error);
  assertResult("customer_payments", paymentResult.error);

  const paymentRows = paymentResult.data ?? [];
  const spendCapped = paymentRows.length > CUSTOMER_PAYMENT_LIMIT;
  const countedPayments = spendCapped ? paymentRows.slice(0, CUSTOMER_PAYMENT_LIMIT) : paymentRows;

  const addressLine = readAddressLine(customer.address);
  const latitude = customer.latitude === null ? null : Number(customer.latitude);
  const longitude = customer.longitude === null ? null : Number(customer.longitude);
  const mapsUrl =
    latitude !== null && longitude !== null && Number.isFinite(latitude) && Number.isFinite(longitude)
      ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`
      : addressLine
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLine)}`
        : null;

  return {
    id: customer.id,
    name: customer.display_name,
    status: customer.status,
    phone: customer.phone,
    email: customer.email,
    source: customer.source,
    notes: typeof customer.notes === "string" && customer.notes.length > 0 ? customer.notes : null,
    addressLine,
    mapsUrl,
    spendByCurrency: capabilities["finance.read"] ? groupTotalsByCurrency(countedPayments) : null,
    spendCapped,
    pets: (petResult.data ?? []).map((pet) => ({
      id: pet.id,
      name: pet.name,
      species: pet.species,
      breed: pet.breed,
      sex: pet.sex,
      ageLabel: ageLabelFromBirthdate(pet.birthdate),
      weightKg: pet.weight_kg === null ? null : Number(pet.weight_kg),
      sizeBand: sizeBandForWeight(pet.weight_kg === null ? null : Number(pet.weight_kg)),
      color: pet.color,
      temperament: pet.temperament,
      notes: typeof pet.notes === "string" && pet.notes.length > 0 ? pet.notes : null,
      status: pet.status,
      medicalFlags: readMedicalFlags(pet.medical_flags),
      customFields: readCustomFields(pet.metadata),
    })),
  };
}

export interface CustomerBookingRow {
  id: string;
  startsAt: string;
  branchId: string;
  status: string;
  fulfillmentMode: string;
  petNames: string[];
  serviceNames: string[];
}

export async function loadCustomerBookings(
  supabase: SupabaseClient,
  organizationId: string,
  customerId: string,
): Promise<CustomerBookingRow[]> {
  const result = await supabase
    .from("bookings")
    .select("id,starts_at,branch_id,status,fulfillment_mode,grooming_jobs(grooming_job_pets(pets(name),grooming_job_pet_services(service_name_snapshot)))")
    .eq("organization_id", organizationId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("starts_at", { ascending: false })
    .limit(CUSTOMER_BOOKING_LIMIT);
  assertResult("customer_bookings", result.error);
  return (result.data ?? []).map((row) => {
    const jobPets = relationRows(row.grooming_jobs).flatMap((job) => relationRows(job.grooming_job_pets));
    return {
      id: row.id,
      startsAt: row.starts_at,
      branchId: row.branch_id,
      status: row.status,
      fulfillmentMode: row.fulfillment_mode,
      petNames: jobPets.flatMap((jobPet) => {
        const name = relationRows(jobPet.pets)[0]?.name;
        return typeof name === "string" ? [name] : [];
      }),
      serviceNames: [
        ...new Set(
          jobPets
            .flatMap((jobPet) => relationRows(jobPet.grooming_job_pet_services))
            .flatMap((line) => (typeof line.service_name_snapshot === "string" ? [line.service_name_snapshot] : [])),
        ),
      ],
    };
  });
}

export interface CustomerInvoiceRow {
  id: string;
  invoiceNumber: string;
  branchId: string;
  status: string;
  total: number;
  currency: string;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  paidAmount: number;
}

export async function loadCustomerInvoices(
  supabase: SupabaseClient,
  organizationId: string,
  customerId: string,
): Promise<CustomerInvoiceRow[]> {
  const invoiceResult = await supabase
    .from("invoices")
    .select("id,invoice_number,branch_id,status,total,currency,issued_at,due_at,paid_at")
    .eq("organization_id", organizationId)
    .eq("customer_id", customerId)
    .order("issued_at", { ascending: false })
    .limit(CUSTOMER_INVOICE_LIMIT);
  assertResult("customer_invoices", invoiceResult.error);
  const invoices = invoiceResult.data ?? [];
  if (invoices.length === 0) return [];

  const paymentResult = await supabase
    .from("payments")
    .select("invoice_id,amount,currency")
    .eq("organization_id", organizationId)
    .eq("status", "succeeded")
    .in("invoice_id", invoices.map((invoice) => invoice.id));
  assertResult("customer_invoice_payments", paymentResult.error);

  // Only payments in the invoice's own currency count toward its settled amount; a
  // payment recorded in another currency needs an explicit conversion policy that the
  // pilot does not define, so it is excluded rather than silently added.
  const paidByInvoice = new Map<string, number>();
  const invoiceCurrency = new Map(invoices.map((invoice) => [invoice.id, invoice.currency]));
  for (const payment of paymentResult.data ?? []) {
    if (typeof payment.invoice_id !== "string") continue;
    if (payment.currency !== invoiceCurrency.get(payment.invoice_id)) continue;
    paidByInvoice.set(payment.invoice_id, (paidByInvoice.get(payment.invoice_id) ?? 0) + Number(payment.amount));
  }

  return invoices.map((invoice) => ({
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    branchId: invoice.branch_id,
    status: invoice.status,
    total: Number(invoice.total),
    currency: invoice.currency,
    issuedAt: invoice.issued_at,
    dueAt: invoice.due_at,
    paidAt: invoice.paid_at,
    paidAmount: paidByInvoice.get(invoice.id) ?? 0,
  }));
}

export interface CustomerPackageRow {
  id: string;
  packageName: string;
  sessionsRemaining: number;
  status: string;
  purchasedAt: string;
  expiresAt: string | null;
}

export async function loadCustomerPackages(
  supabase: SupabaseClient,
  organizationId: string,
  customerId: string,
): Promise<CustomerPackageRow[]> {
  const result = await supabase
    .from("customer_packages")
    .select("id,package_id,sessions_remaining,status,purchased_at,expires_at,packages(name)")
    .eq("organization_id", organizationId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("purchased_at", { ascending: false })
    .limit(CUSTOMER_INVOICE_LIMIT);
  assertResult("customer_packages", result.error);
  return (result.data ?? []).map((row) => ({
    id: row.id,
    packageName: (() => {
      const name = relationRows(row.packages)[0]?.name;
      return typeof name === "string" ? name : "Paket";
    })(),
    sessionsRemaining: Number(row.sessions_remaining) || 0,
    status: row.status,
    purchasedAt: row.purchased_at,
    expiresAt: row.expires_at,
  }));
}

export interface CustomerHistoryRow {
  id: string;
  subjectType: string;
  eventType: string;
  summary: string | null;
  occurredAt: string;
}

export async function loadCustomerHistory(
  supabase: SupabaseClient,
  organizationId: string,
  customerId: string,
  petIds: readonly string[],
): Promise<CustomerHistoryRow[]> {
  const subjectIds = [customerId, ...petIds];
  const result = await supabase
    .from("timeline_events")
    .select("id,subject_type,event_type,summary,occurred_at")
    .eq("organization_id", organizationId)
    .in("subject_type", ["customer", "pet"])
    .in("subject_id", subjectIds)
    .order("occurred_at", { ascending: false })
    .limit(CUSTOMER_HISTORY_LIMIT);
  assertResult("customer_history", result.error);
  return (result.data ?? []).map((row) => ({
    id: row.id,
    subjectType: row.subject_type,
    eventType: row.event_type,
    summary: typeof row.summary === "string" && row.summary.length > 0 ? row.summary : null,
    occurredAt: row.occurred_at,
  }));
}
