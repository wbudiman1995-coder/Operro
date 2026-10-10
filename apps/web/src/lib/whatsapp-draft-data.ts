/**
 * Function index:
 * - loadWhatsAppDrafts: RLS-scoped, keyset-paginated draft list enriched with the live state of each customer.
 * - loadDraftCandidates: existing invoice / follow-up / renewal sources that can be turned into a draft.
 *
 * Tenant and capability scoping is done by the database (RLS on whatsapp_drafts keyed on the source capability);
 * the organization filter below is defence in depth, never the only gate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CapabilityMap } from "@/lib/authorization";
import { loadOverdueQueue, loadRenewalQueue, type OverdueCustomerGroup, type RenewalCustomerGroup } from "@/lib/followup-retention";
import { type DraftHealth, type WhatsAppSource, type WhatsAppStatus } from "@/lib/whatsapp-drafts";

export const WHATSAPP_PAGE_SIZE = 25;

export interface DraftCursor { createdAt: string; id: string }
export interface WhatsAppDraftRow {
  id: string;
  sourceType: WhatsAppSource;
  sourceId: string;
  customerId: string | null;
  customerName: string | null;
  recipientPhone: string | null;
  messageText: string;
  status: WhatsAppStatus;
  statusNote: string | null;
  statusChangedAt: string;
  statusChangedBy: string | null;
  createdAt: string;
  health: DraftHealth;
}
export interface WhatsAppDraftPage { rows: WhatsAppDraftRow[]; hasMore: boolean; nextCursor: DraftCursor | null }

interface DraftDbRow {
  id: string; source_type: WhatsAppSource; source_id: string; customer_id: string | null; recipient_phone: string | null;
  message_text: string; status: WhatsAppStatus; status_note: string | null; status_changed_at: string; status_changed_by: string | null; created_at: string;
}

export async function loadWhatsAppDrafts(
  supabase: SupabaseClient,
  organizationId: string,
  options: { status?: WhatsAppStatus; source?: WhatsAppSource; cursor?: DraftCursor; pageSize?: number } = {},
): Promise<WhatsAppDraftPage> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? WHATSAPP_PAGE_SIZE, 100));
  let query = supabase.from("whatsapp_drafts")
    .select("id,source_type,source_id,customer_id,recipient_phone,message_text,status,status_note,status_changed_at,status_changed_by,created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(pageSize + 1);
  if (options.status) query = query.eq("status", options.status);
  if (options.source) query = query.eq("source_type", options.source);
  if (options.cursor) query = query.or(`created_at.lt.${options.cursor.createdAt},and(created_at.eq.${options.cursor.createdAt},id.lt.${options.cursor.id})`);
  const { data, error } = await query;
  if (error) throw new Error(`whatsapp_drafts_failed:${error.message}`);

  const all = (data ?? []) as DraftDbRow[];
  const hasMore = all.length > pageSize;
  const page = hasMore ? all.slice(0, pageSize) : all;
  const customerIds = [...new Set(page.flatMap((row) => (row.customer_id ? [row.customer_id] : [])))];
  const actorIds = [...new Set(page.flatMap((row) => (row.status_changed_by ? [row.status_changed_by] : [])))];

  const [customers, prefs, actors] = await Promise.all([
    customerIds.length ? supabase.from("customers").select("id,display_name,phone,deleted_at").eq("organization_id", organizationId).in("id", customerIds) : Promise.resolve({ data: [], error: null }),
    customerIds.length ? supabase.from("whatsapp_contact_preferences").select("customer_id").eq("organization_id", organizationId).in("customer_id", customerIds) : Promise.resolve({ data: [], error: null }),
    actorIds.length ? supabase.from("users").select("id,full_name,email").in("id", actorIds) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const [scope, result] of [["customers", customers], ["preferences", prefs], ["actors", actors]] as const) {
    if (result.error) throw new Error(`whatsapp_drafts_${scope}_failed:${result.error.message}`);
  }
  const customerById = new Map((customers.data ?? []).map((row) => [row.id as string, row]));
  const optedOut = new Set((prefs.data ?? []).map((row) => row.customer_id as string));
  const actorName = new Map((actors.data ?? []).map((row) => [row.id as string, (row.full_name || row.email || "Pengguna") as string]));

  const digits = (phone: string | null) => {
    const d = (phone ?? "").replace(/\D/g, "");
    return d.length >= 8 && d.length <= 15 ? (d.startsWith("0") ? `62${d.slice(1)}` : d) : null;
  };
  const rows: WhatsAppDraftRow[] = page.map((row) => {
    const customer = row.customer_id ? customerById.get(row.customer_id) : undefined;
    return {
      id: row.id, sourceType: row.source_type, sourceId: row.source_id, customerId: row.customer_id,
      customerName: customer ? (customer.display_name as string) : null,
      recipientPhone: row.recipient_phone, messageText: row.message_text, status: row.status, statusNote: row.status_note,
      statusChangedAt: row.status_changed_at, statusChangedBy: row.status_changed_by ? actorName.get(row.status_changed_by) ?? null : null,
      createdAt: row.created_at,
      health: {
        optedOut: row.customer_id ? optedOut.has(row.customer_id) : false,
        customerArchived: row.customer_id ? !customer || customer.deleted_at !== null : false,
        phoneChanged: Boolean(customer && row.recipient_phone && digits(customer.phone as string | null) !== row.recipient_phone),
      },
    };
  });
  const last = page[page.length - 1];
  return { rows, hasMore, nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null };
}

export interface InvoiceCandidate { id: string; invoiceNumber: string; customerName: string; total: number; currency: string; hasPhone: boolean }
export interface DraftCandidates {
  invoices: InvoiceCandidate[] | null;
  followups: OverdueCustomerGroup[] | null;
  renewals: RenewalCustomerGroup[] | null;
}

/** null = the caller lacks the capability for that source (restricted, not "nothing to do"). */
export async function loadDraftCandidates(supabase: SupabaseClient, organizationId: string, capabilities: CapabilityMap): Promise<DraftCandidates> {
  const invoices = capabilities["finance.read"]
    ? await (async () => {
        const result = await supabase.from("invoices").select("id,invoice_number,customer_id,total,currency")
          .eq("organization_id", organizationId).eq("status", "issued").order("issued_at", { ascending: false }).limit(10);
        if (result.error) throw new Error(`whatsapp_candidates_invoices_failed:${result.error.message}`);
        const ids = [...new Set((result.data ?? []).flatMap((row) => (row.customer_id ? [row.customer_id as string] : [])))];
        const customers = ids.length ? await supabase.from("customers").select("id,display_name,phone").eq("organization_id", organizationId).in("id", ids) : { data: [], error: null };
        if (customers.error) throw new Error(`whatsapp_candidates_customers_failed:${customers.error.message}`);
        const byId = new Map((customers.data ?? []).map((row) => [row.id as string, row]));
        return (result.data ?? []).map((row) => {
          const customer = byId.get(row.customer_id as string);
          return { id: row.id as string, invoiceNumber: row.invoice_number as string, customerName: (customer?.display_name as string) ?? "Pelanggan", total: Number(row.total), currency: row.currency as string, hasPhone: Boolean(customer?.phone) };
        });
      })()
    : null;
  const followups = capabilities["customer.read"] ? (await loadOverdueQueue(supabase, { pageSize: 10 })).groups : null;
  const renewals = capabilities["membership.read"] ? (await loadRenewalQueue(supabase, { pageSize: 10 })).groups : null;
  return { invoices, followups, renewals };
}
