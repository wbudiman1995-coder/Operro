"use server";

import { revalidatePath } from "next/cache";

import { loadInvoiceDocument } from "@/lib/invoice-document";
import { buildFollowupMessage, buildRenewalMessage } from "@/lib/followup-messages";
import { loadFollowupRetentionSettings, loadOverdueQueue } from "@/lib/followup-retention";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { invoiceDraftMessage, isWhatsAppSource, isWhatsAppStatus } from "@/lib/whatsapp-drafts";

export interface WhatsAppActionState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS: Record<string, string> = {
  recipient_opted_out: "Pelanggan berhenti menerima pesan WhatsApp.",
  recipient_phone_missing: "Nomor WhatsApp pelanggan tidak tersedia atau tidak valid.",
  source_archived: "Pelanggan sudah diarsipkan.",
  source_not_found: "Sumber pesan tidak ditemukan atau tidak lagi memenuhi syarat.",
  invalid_message: "Isi pesan tidak valid atau masih memuat variabel yang belum terisi.",
  invalid_transition: "Status tidak dapat diubah dari kondisi saat ini. Muat ulang halaman.",
  draft_not_found: "Draf tidak ditemukan.",
  secret_in_message: "Pesan memuat tautan sekali pakai dan tidak boleh disimpan.",
};
function describe(error: { code?: string; message?: string }): string {
  if (error.code === "42501") return "Anda tidak memiliki izin untuk sumber pesan ini.";
  for (const [key, text] of Object.entries(ERRORS)) if (error.message?.includes(key)) return text;
  return "Perubahan belum tersimpan. Coba lagi.";
}
function single(formData: FormData, key: string): string | null {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

/** Builds the message on the server from the stored templates; the browser supplies only a source reference. */
export async function createWhatsAppDraftAction(_previous: WhatsAppActionState, formData: FormData): Promise<WhatsAppActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const sourceType = single(formData, "sourceType");
    const sourceId = single(formData, "sourceId");
    if (!isWhatsAppSource(sourceType) || sourceType === "onboarding" || !sourceId || !UUID.test(sourceId)) return { error: "Sumber pesan tidak valid.", success: null };
    const businessName = workspace.activeOrganization.name;
    let text: string | null = null;
    let blocked: string | null = null;

    if (sourceType === "invoice") {
      if (!workspace.capabilities["finance.read"]) return { error: "Anda tidak memiliki izin melihat invoice.", success: null };
      const doc = await loadInvoiceDocument(workspace.supabase, workspace.activeOrganization.id, sourceId);
      if (!doc) return { error: ERRORS.source_not_found, success: null };
      const templates = doc.organization.waTemplates;
      const template = doc.balanceDue <= 0 ? templates.paidCompletion : doc.billingMode === "package_sale" ? templates.subscriptionBilling : templates.outstanding;
      ({ text, blockedReason: blocked } = invoiceDraftMessage({
        template, customerName: doc.customer.name, invoiceNumber: doc.invoiceNumber,
        amount: doc.balanceDue <= 0 ? doc.total : doc.balanceDue, currency: doc.currency, notes: doc.customerNotes ?? "",
      }));
    } else if (sourceType === "followup") {
      if (!workspace.capabilities["customer.read"]) return { error: "Anda tidak memiliki izin melihat pelanggan.", success: null };
      const customer = await workspace.supabase.from("customers").select("display_name").eq("organization_id", workspace.activeOrganization.id).eq("id", sourceId).is("deleted_at", null).maybeSingle();
      if (customer.error || !customer.data) return { error: ERRORS.source_not_found, success: null };
      const [settings, queue] = await Promise.all([
        loadFollowupRetentionSettings(workspace.supabase),
        loadOverdueQueue(workspace.supabase, { search: customer.data.display_name as string, pageSize: 50 }),
      ]);
      const group = queue.groups.find((candidate) => candidate.customerId === sourceId);
      if (!group) return { error: "Pelanggan ini tidak lagi masuk daftar follow-up.", success: null };
      ({ text, blockedReason: blocked } = buildFollowupMessage(settings.followupTemplate, {
        customerName: group.customerName, businessName,
        pets: group.pets.flatMap((pet) => (pet.daysSince === null ? [] : [{ name: pet.petName, daysSince: pet.daysSince }])),
      }));
    } else {
      if (!workspace.capabilities["membership.read"]) return { error: "Anda tidak memiliki izin melihat paket.", success: null };
      const preview = await workspace.supabase.schema("app").rpc("preview_package_renewal", { p_customer_package: sourceId });
      if (preview.error || !preview.data) return { error: ERRORS.source_not_found, success: null };
      const data = preview.data as Record<string, unknown>;
      const membership = await workspace.supabase.from("customer_packages").select("customer_id").eq("organization_id", workspace.activeOrganization.id).eq("id", sourceId).maybeSingle();
      const customer = membership.data ? await workspace.supabase.from("customers").select("display_name").eq("organization_id", workspace.activeOrganization.id).eq("id", membership.data.customer_id as string).maybeSingle() : null;
      const pet = data.pet_id ? await workspace.supabase.from("pets").select("name").eq("organization_id", workspace.activeOrganization.id).eq("id", String(data.pet_id)).maybeSingle() : null;
      if (!customer?.data) return { error: ERRORS.source_not_found, success: null };
      const settings = await loadFollowupRetentionSettings(workspace.supabase);
      const incompatible = Boolean(data.incompatible);
      ({ text, blockedReason: blocked } = buildRenewalMessage(settings.renewalTemplate, {
        customerName: customer.data.display_name as string, petLabel: (pet?.data?.name as string | undefined) ?? null, tierName: String(data.package_name), businessName,
        amount: Number(data.price), currency: String(data.currency),
        amountBlockedReason: incompatible ? (data.blocking_reason ? String(data.blocking_reason) : "Paket tidak dapat diperpanjang saat ini.") : null,
      }));
    }
    if (blocked || !text) return { error: blocked ?? "Pesan tidak dapat dibuat.", success: null };

    const { data, error } = await workspace.supabase.schema("app").rpc("create_whatsapp_draft", { p_source_type: sourceType, p_source_id: sourceId, p_message: text });
    if (error) {
      console.error("whatsapp_draft_create_failed", error);
      return { error: describe(error), success: null };
    }
    revalidatePath("/whatsapp");
    const created = (data as { created?: boolean } | null)?.created !== false;
    return { error: null, success: created ? "Draf dibuat. Belum ada pesan yang dikirim." : "Draf untuk sumber ini sudah ada di antrean." };
  } catch (error) {
    console.error("whatsapp_draft_create_unexpected", error);
    return { error: "Draf belum dapat dibuat. Coba lagi.", success: null };
  }
}

/** Records what the person did/reported. It never contacts WhatsApp. */
export async function setWhatsAppDraftStatusAction(_previous: WhatsAppActionState, formData: FormData): Promise<WhatsAppActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const id = single(formData, "id");
    const status = single(formData, "status");
    const note = single(formData, "note") ?? "";
    if (!id || !UUID.test(id) || !isWhatsAppStatus(status) || note.length > 300) return { error: "Permintaan tidak valid.", success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_whatsapp_draft_status", { p_id: id, p_status: status, p_note: note.trim() || null });
    if (error) {
      console.error("whatsapp_draft_status_failed", error);
      return { error: describe(error), success: null };
    }
    revalidatePath("/whatsapp");
    return { error: null, success: "Status dicatat (laporan pengguna, bukan konfirmasi pengiriman)." };
  } catch (error) {
    console.error("whatsapp_draft_status_unexpected", error);
    return { error: "Status belum tersimpan. Coba lagi.", success: null };
  }
}

export async function setWhatsAppOptOutAction(_previous: WhatsAppActionState, formData: FormData): Promise<WhatsAppActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const customerId = single(formData, "customerId");
    const optedOut = single(formData, "optedOut");
    if (!customerId || !UUID.test(customerId) || (optedOut !== "true" && optedOut !== "false")) return { error: "Permintaan tidak valid.", success: null };
    if (!workspace.capabilities["customer.manage"]) return { error: "Anda tidak memiliki izin mengubah preferensi kontak pelanggan.", success: null };
    const { data, error } = await workspace.supabase.schema("app").rpc("set_whatsapp_opt_out", { p_customer: customerId, p_opted_out: optedOut === "true" });
    if (error) {
      console.error("whatsapp_opt_out_failed", error);
      return { error: describe(error), success: null };
    }
    revalidatePath("/whatsapp");
    return { error: null, success: optedOut === "true" ? `Pelanggan tidak akan menerima draf baru. ${Number(data) || 0} draf aktif dibatalkan.` : "Pelanggan dapat menerima draf lagi." };
  } catch (error) {
    console.error("whatsapp_opt_out_unexpected", error);
    return { error: "Perubahan belum tersimpan. Coba lagi.", success: null };
  }
}
