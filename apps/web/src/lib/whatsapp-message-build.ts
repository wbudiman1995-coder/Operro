/**
 * Function index:
 * - buildDraftMessage: builds the WhatsApp text for ONE invoice / follow-up / renewal source from the organization's stored
 *   templates and live data, or says why it cannot. Shared by the single-draft action and the batch actions.
 *
 * The browser never supplies text, phone or organization: a source id is all it sends. Unknown template variables are
 * refused (never blanked), and the database re-validates the text and the recipient when the draft is stored.
 * Nothing here sends anything.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CapabilityMap } from "@/lib/authorization";
import { buildFollowupMessage, buildRenewalMessage } from "@/lib/followup-messages";
import { loadFollowupRetentionSettings, loadOverdueQueue } from "@/lib/followup-retention";
import { loadInvoiceDocument } from "@/lib/invoice-document";
import { invoiceDraftMessage } from "@/lib/whatsapp-drafts";

export type BatchSource = "invoice" | "followup" | "renewal";
export interface BuildContext { supabase: SupabaseClient; activeOrganization: { id: string; name: string }; capabilities: CapabilityMap }
export type BuiltMessage = { ok: true; text: string; label: string } | { ok: false; error: string };

export const MESSAGE_ERRORS = {
  notFound: "Sumber pesan tidak ditemukan atau tidak lagi memenuhi syarat.",
  noFinance: "Anda tidak memiliki izin melihat invoice.",
  noCustomers: "Anda tidak memiliki izin melihat pelanggan.",
  noPackages: "Anda tidak memiliki izin melihat paket.",
  notQueued: "Pelanggan ini tidak lagi masuk daftar follow-up.",
  cannotBuild: "Pesan tidak dapat dibuat.",
} as const;

export async function buildDraftMessage(ctx: BuildContext, sourceType: BatchSource, sourceId: string): Promise<BuiltMessage> {
  const { supabase, activeOrganization, capabilities } = ctx;
  const businessName = activeOrganization.name;
  let text: string | null = null;
  let blocked: string | null = null;
  let label = "";

  if (sourceType === "invoice") {
    if (!capabilities["finance.read"]) return { ok: false, error: MESSAGE_ERRORS.noFinance };
    const doc = await loadInvoiceDocument(supabase, activeOrganization.id, sourceId);
    if (!doc) return { ok: false, error: MESSAGE_ERRORS.notFound };
    const templates = doc.organization.waTemplates;
    const template = doc.balanceDue <= 0 ? templates.paidCompletion : doc.billingMode === "package_sale" ? templates.subscriptionBilling : templates.outstanding;
    label = `${doc.invoiceNumber} · ${doc.customer.name}`;
    ({ text, blockedReason: blocked } = invoiceDraftMessage({
      template, customerName: doc.customer.name, invoiceNumber: doc.invoiceNumber,
      amount: doc.balanceDue <= 0 ? doc.total : doc.balanceDue, currency: doc.currency, notes: doc.customerNotes ?? "",
    }));
  } else if (sourceType === "followup") {
    if (!capabilities["customer.read"]) return { ok: false, error: MESSAGE_ERRORS.noCustomers };
    const customer = await supabase.from("customers").select("display_name").eq("organization_id", activeOrganization.id).eq("id", sourceId).is("deleted_at", null).maybeSingle();
    if (customer.error || !customer.data) return { ok: false, error: MESSAGE_ERRORS.notFound };
    const [settings, queue] = await Promise.all([
      loadFollowupRetentionSettings(supabase),
      loadOverdueQueue(supabase, { search: customer.data.display_name as string, pageSize: 50 }),
    ]);
    const group = queue.groups.find((candidate) => candidate.customerId === sourceId);
    if (!group) return { ok: false, error: MESSAGE_ERRORS.notQueued };
    label = group.customerName;
    ({ text, blockedReason: blocked } = buildFollowupMessage(settings.followupTemplate, {
      customerName: group.customerName, businessName,
      pets: group.pets.flatMap((pet) => (pet.daysSince === null ? [] : [{ name: pet.petName, daysSince: pet.daysSince }])),
    }));
  } else {
    if (!capabilities["membership.read"]) return { ok: false, error: MESSAGE_ERRORS.noPackages };
    const preview = await supabase.schema("app").rpc("preview_package_renewal", { p_customer_package: sourceId });
    if (preview.error || !preview.data) return { ok: false, error: MESSAGE_ERRORS.notFound };
    const data = preview.data as Record<string, unknown>;
    const membership = await supabase.from("customer_packages").select("customer_id").eq("organization_id", activeOrganization.id).eq("id", sourceId).maybeSingle();
    const customer = membership.data ? await supabase.from("customers").select("display_name").eq("organization_id", activeOrganization.id).eq("id", membership.data.customer_id as string).maybeSingle() : null;
    const pet = data.pet_id ? await supabase.from("pets").select("name").eq("organization_id", activeOrganization.id).eq("id", String(data.pet_id)).maybeSingle() : null;
    if (!customer?.data) return { ok: false, error: MESSAGE_ERRORS.notFound };
    const settings = await loadFollowupRetentionSettings(supabase);
    const incompatible = Boolean(data.incompatible);
    label = `${customer.data.display_name as string} · ${String(data.package_name)}`;
    ({ text, blockedReason: blocked } = buildRenewalMessage(settings.renewalTemplate, {
      customerName: customer.data.display_name as string, petLabel: (pet?.data?.name as string | undefined) ?? null, tierName: String(data.package_name), businessName,
      amount: Number(data.price), currency: String(data.currency),
      amountBlockedReason: incompatible ? (data.blocking_reason ? String(data.blocking_reason) : "Paket tidak dapat diperpanjang saat ini.") : null,
    }));
  }
  if (blocked || !text) return { ok: false, error: blocked ?? MESSAGE_ERRORS.cannotBuild };
  return { ok: true, text, label };
}
