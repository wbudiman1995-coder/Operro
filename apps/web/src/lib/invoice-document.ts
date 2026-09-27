/**
 * Section 27 — invoice document assembly: everything a branded, printable
 * customer-facing invoice/service-report needs, read from the SAME
 * persisted snapshots the rest of the app already trusts (invoice_lines,
 * groomer_name_snapshot, customer_package_ledger) — never recomputed from
 * today's catalog, and never joined against another customer's data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface InvoiceDocument {
  id: string;
  invoiceNumber: string;
  status: string;
  billingMode: string;
  documentType: string;
  issuedAt: string;
  dueAt: string | null;
  currency: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  paidTotal: number;
  balanceDue: number;
  customerNotes: string | null;
  internalGroomerNotes: string | null;
  revision: number;
  groomerName: string | null;
  organization: { name: string; tagline: string; logoUrl: string | null; membershipTerms: string; waTemplates: { paidCompletion: string; outstanding: string; subscriptionBilling: string } };
  bankAccounts: Array<{ bankName: string; accountNumber: string; accountHolder: string; isPrimary: boolean }>;
  customer: { id: string; name: string; phone: string | null; address: string | null };
  pets: string[];
  lines: Array<{ id: string; itemType: string; name: string; quantity: number; unitPrice: number; discountAmount: number; taxAmount: number; lineTotal: number }>;
  packageBalance: PackageCoverage | null;
  photos: Array<{ id: string; category: string; url: string }>;
}

function assertResult(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`invoice_document_${scope}_failed:${error.message}`);
}

/**
 * C8: canonical, ledger-backed package coverage — not a metadata match plus
 * a cached balance. `sessionsAvailable` is summed directly from
 * customer_package_ledger (the append-only source of truth; `sessions_remaining`
 * on customer_packages is documented as just a derived cache of it), always
 * labeled as the CURRENT balance, never portrayed as this invoice's
 * historical state. "purchase" = this invoice IS the package sale;
 * "consumption" = this invoice is a service report for a visit that drew
 * down an EXISTING package via package_reservations — the two cases have
 * different, real links and must not be conflated. "unavailable" means real
 * usage was found but the linkage is ambiguous/inconsistent — an honest
 * review state, never an invented zero.
 */
export interface PackageCoverage {
  status: "purchase" | "consumption" | "unavailable";
  packageName: string;
  sessionsAvailable: number;
  sessionsUsedThisVisit: number | null;
  packageStatus: string | null;
  expiresAt: string | null;
  reviewNote: string | null;
}

async function sumPackageLedger(supabase: SupabaseClient, organizationId: string, customerPackageId: string): Promise<number> {
  const ledger = await supabase.from("customer_package_ledger").select("delta").eq("organization_id", organizationId).eq("customer_package_id", customerPackageId);
  assertResult("package_ledger", ledger.error);
  return (ledger.data ?? []).reduce((sum, row) => sum + Number(row.delta), 0);
}

function packageNameFromJoin(row: { packages: unknown }): string {
  const pkg = (Array.isArray(row.packages) ? row.packages[0] : row.packages) as { name?: string } | null;
  return pkg?.name ?? "Paket";
}

async function resolvePackageCoverage(
  supabase: SupabaseClient, organizationId: string, invoiceId: string, customerId: string, billingMode: string, bookingId: string | null,
): Promise<PackageCoverage | null> {
  if (billingMode === "package_sale") {
    const cp = await supabase.from("customer_packages").select("id,status,expires_at,packages(name)").eq("organization_id", organizationId).eq("customer_id", customerId).contains("metadata", { source_invoice_id: invoiceId }).maybeSingle();
    assertResult("customer_packages", cp.error);
    if (!cp.data) return null;
    const sessionsAvailable = await sumPackageLedger(supabase, organizationId, cp.data.id);
    return { status: "purchase", packageName: packageNameFromJoin(cp.data), sessionsAvailable, sessionsUsedThisVisit: null, packageStatus: cp.data.status, expiresAt: cp.data.expires_at, reviewNote: null };
  }

  if (!bookingId) return null;
  const gjp = await supabase.from("grooming_job_pets").select("id").eq("organization_id", organizationId).eq("grooming_job_id", bookingId).is("deleted_at", null);
  assertResult("package_coverage_gjp", gjp.error);
  const gjpIds = (gjp.data ?? []).map((r) => r.id);
  if (!gjpIds.length) return null;

  const lines = await supabase.from("grooming_job_pet_services").select("id").eq("organization_id", organizationId).in("grooming_job_pet_id", gjpIds).is("deleted_at", null);
  assertResult("package_coverage_lines", lines.error);
  const lineIds = (lines.data ?? []).map((r) => r.id);
  if (!lineIds.length) return null;

  const reservations = await supabase.from("package_reservations").select("id,customer_package_id,status").eq("organization_id", organizationId).in("grooming_job_pet_service_id", lineIds).in("status", ["reserved", "consumed"]);
  assertResult("package_reservations", reservations.error);
  const rows = reservations.data ?? [];
  if (!rows.length) return null; // this visit was genuinely not paid via a package — not an error

  const distinctPackageIds = Array.from(new Set(rows.map((r) => r.customer_package_id)));
  if (distinctPackageIds.length > 1) {
    return { status: "unavailable", packageName: "Beberapa paket", sessionsAvailable: 0, sessionsUsedThisVisit: rows.length, packageStatus: null, expiresAt: null, reviewNote: "Kunjungan ini menggunakan lebih dari satu paket — perlu ditinjau manual, saldo tidak ditampilkan otomatis." };
  }

  const cp = await supabase.from("customer_packages").select("id,status,expires_at,packages(name)").eq("organization_id", organizationId).eq("id", distinctPackageIds[0]).maybeSingle();
  assertResult("customer_packages", cp.error);
  if (!cp.data) {
    return { status: "unavailable", packageName: "Paket", sessionsAvailable: 0, sessionsUsedThisVisit: rows.length, packageStatus: null, expiresAt: null, reviewNote: "Riwayat paket untuk kunjungan ini tidak ditemukan atau tidak konsisten — perlu ditinjau manual." };
  }
  const sessionsAvailable = await sumPackageLedger(supabase, organizationId, cp.data.id);
  return { status: "consumption", packageName: packageNameFromJoin(cp.data), sessionsAvailable, sessionsUsedThisVisit: rows.length, packageStatus: cp.data.status, expiresAt: cp.data.expires_at, reviewNote: null };
}

const DEFAULT_WA = {
  paidCompletion: "Halo {customer}, invoice {number} sebesar {total} sudah lunas. Terima kasih telah mempercayakan perawatan hewan Anda pada kami!",
  outstanding: "Halo {customer}, invoice {number} sebesar {total} masih belum lunas. Mohon konfirmasi pembayarannya ya. Terima kasih.",
  subscriptionBilling: "Halo {customer}, tagihan langganan {number} sebesar {total} sudah kami terbitkan.",
};

export async function loadInvoiceDocument(supabase: SupabaseClient, organizationId: string, invoiceId: string): Promise<InvoiceDocument | null> {
  const invoice = await supabase.from("invoices")
    .select("id,invoice_number,status,billing_mode,document_type,issued_at,due_at,currency,subtotal,discount_total,tax_total,total,customer_notes,revision,groomer_name_snapshot,customer_id,order_id,metadata")
    .eq("organization_id", organizationId).eq("id", invoiceId).maybeSingle();
  assertResult("invoice", invoice.error);
  if (!invoice.data) return null;
  const row = invoice.data;

  const [org, bankAccounts, customer, address, lines, payments] = await Promise.all([
    supabase.from("organizations").select("name,settings").eq("id", organizationId).single(),
    supabase.from("organization_bank_accounts").select("bank_name,account_number,account_holder,is_primary").eq("organization_id", organizationId).is("deleted_at", null).order("sort_order"),
    supabase.from("customers").select("id,display_name,phone").eq("organization_id", organizationId).eq("id", row.customer_id).maybeSingle(),
    supabase.from("customer_addresses").select("line1,kecamatan,kabupaten_kota,province").eq("organization_id", organizationId).eq("customer_id", row.customer_id).eq("is_default", true).maybeSingle(),
    supabase.from("invoice_lines").select("id,item_type,name_snapshot,quantity,unit_price,discount_amount,tax_amount,line_total").eq("organization_id", organizationId).eq("invoice_id", invoiceId),
    supabase.from("payments").select("amount").eq("organization_id", organizationId).eq("invoice_id", invoiceId).eq("status", "succeeded"),
  ]);
  assertResult("org", org.error); assertResult("bank_accounts", bankAccounts.error); assertResult("customer", customer.error);
  assertResult("lines", lines.error); assertResult("payments", payments.error);
  if (!customer.data) throw new Error("invoice_document_customer_mismatch");

  const settings = (org.data?.settings as { documents?: { tagline?: string; logo_attachment_id?: string; membership_terms?: string; whatsapp_templates?: Record<string, string> } } | null) ?? {};
  const documents = settings.documents ?? {};
  const wa = documents.whatsapp_templates ?? {};

  let logoUrl: string | null = null;
  if (documents.logo_attachment_id) {
    const logo = await supabase.from("attachments").select("storage_path").eq("organization_id", organizationId).eq("id", documents.logo_attachment_id).is("deleted_at", null).maybeSingle();
    if (logo.data) {
      const signed = await supabase.storage.from("attachments").createSignedUrl(logo.data.storage_path, 3600);
      logoUrl = signed.data?.signedUrl ?? null;
    }
  }

  const paidTotal = (payments.data ?? []).reduce((sum, p) => sum + Number(p.amount), 0);

  let bookingId: string | null = null;
  let internalGroomerNotes: string | null = null;
  if (row.order_id) {
    const order = await supabase.from("orders").select("booking_id").eq("organization_id", organizationId).eq("id", row.order_id).maybeSingle();
    assertResult("order", order.error);
    bookingId = order.data?.booking_id ?? null;
    if (bookingId) {
      // Internal operational instructions (grooming_jobs.groomer_notes) —
      // never rendered on the document itself. Surfaced only so the invoice
      // page can offer an EXPLICIT review/copy step into the separate,
      // already-customer-facing invoices.customer_notes field (C4: these
      // must stay distinct, with a human deciding what becomes visible).
      const job = await supabase.from("grooming_jobs").select("groomer_notes").eq("organization_id", organizationId).eq("booking_id", bookingId).maybeSingle();
      assertResult("grooming_job", job.error);
      internalGroomerNotes = job.data?.groomer_notes ?? null;
    }
  }

  let pets: string[] = [];
  let photos: InvoiceDocument["photos"] = [];
  if (bookingId && row.billing_mode !== "package_sale") {
    const [gjp, links] = await Promise.all([
      supabase.from("grooming_job_pets").select("pet_id").eq("organization_id", organizationId).eq("grooming_job_id", bookingId).is("deleted_at", null),
      // Package-sale invoices deliberately EXCLUDE grooming photo pages (brief §27/§28).
      supabase.from("attachment_links").select("attachment_id").eq("organization_id", organizationId).eq("subject_type", "booking").eq("subject_id", bookingId),
    ]);
    assertResult("grooming_job_pets", gjp.error); assertResult("attachment_links", links.error);
    const petIds = (gjp.data ?? []).map((r) => r.pet_id);
    const attachmentIds = (links.data ?? []).map((l) => l.attachment_id);
    const [petsResult, attachments] = await Promise.all([
      petIds.length ? supabase.from("pets").select("name").eq("organization_id", organizationId).in("id", petIds) : Promise.resolve({ data: [] as { name: string }[], error: null }),
      attachmentIds.length ? supabase.from("attachments").select("id,storage_bucket,storage_path,metadata").eq("organization_id", organizationId).in("id", attachmentIds).is("deleted_at", null) : Promise.resolve({ data: [] as { id: string; storage_bucket: string; storage_path: string; metadata: unknown }[], error: null }),
    ]);
    assertResult("pets", petsResult.error); assertResult("attachments", attachments.error);
    pets = (petsResult.data ?? []).map((p) => p.name);

    const relevant = (attachments.data ?? []).filter((a) => {
      const category = (a.metadata as { category?: string } | null)?.category;
      return category && category !== "attendance"; // attendance photos are internal, not customer-facing
    });
    // Batched signed-URL generation (one call for the whole set, not one per
    // photo) - the per-row waterfall pattern flagged elsewhere in this codebase
    // (pilot-data.ts's my-schedule/attendance loaders) is exactly what this
    // avoids, and it also means one flaky network blip can't fail N separate
    // requests instead of one.
    if (relevant.length) {
      const signed = await supabase.storage.from("attachments").createSignedUrls(relevant.map((a) => a.storage_path), 3600);
      assertResult("signed_urls", signed.error);
      const urlByPath = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]));
      photos = relevant.flatMap((a) => {
        const url = urlByPath.get(a.storage_path);
        return url ? [{ id: a.id, category: (a.metadata as { category?: string } | null)?.category ?? "other", url }] : [];
      });
    }
  }

  const packageBalance = await resolvePackageCoverage(supabase, organizationId, invoiceId, row.customer_id, row.billing_mode, bookingId);

  return {
    id: row.id, invoiceNumber: row.invoice_number, status: row.status, billingMode: row.billing_mode, documentType: row.document_type,
    issuedAt: row.issued_at, dueAt: row.due_at, currency: row.currency, subtotal: Number(row.subtotal), discountTotal: Number(row.discount_total),
    taxTotal: Number(row.tax_total), total: Number(row.total), paidTotal, balanceDue: Math.max(0, Number(row.total) - paidTotal),
    customerNotes: row.customer_notes, internalGroomerNotes, revision: row.revision, groomerName: row.groomer_name_snapshot,
    organization: {
      name: org.data?.name ?? "Operro", tagline: documents.tagline ?? "", logoUrl, membershipTerms: documents.membership_terms ?? "",
      waTemplates: { paidCompletion: wa.paid_completion || DEFAULT_WA.paidCompletion, outstanding: wa.outstanding || DEFAULT_WA.outstanding, subscriptionBilling: wa.subscription_billing || DEFAULT_WA.subscriptionBilling },
    },
    bankAccounts: (bankAccounts.data ?? []).map((a) => ({ bankName: a.bank_name, accountNumber: a.account_number, accountHolder: a.account_holder, isPrimary: a.is_primary })),
    customer: { id: customer.data.id, name: customer.data.display_name, phone: customer.data.phone, address: address.data ? [address.data.line1, address.data.kecamatan, address.data.kabupaten_kota, address.data.province].filter(Boolean).join(", ") : null },
    pets,
    lines: (lines.data ?? []).map((l) => ({ id: l.id, itemType: l.item_type, name: l.name_snapshot, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), discountAmount: Number(l.discount_amount), taxAmount: Number(l.tax_amount), lineTotal: Number(l.line_total) })),
    packageBalance,
    photos,
  };
}
