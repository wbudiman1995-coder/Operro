"use server";

/**
 * Section 27 — invoice document settings: branding, bank accounts, WhatsApp
 * templates. Kept separate from pilot-actions.ts (new surface).
 */
import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export interface DocumentSettingsActionState { error: string | null; success: string | null }

async function workspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return null;
  return { supabase, organizationId: context.activeOrganization.id, userId: context.user.id };
}

function mapError(scope: string, message: string): DocumentSettingsActionState {
  if (/not_authorized/.test(message)) return { error: `${scope}: Anda tidak memiliki akses untuk aksi ini`, success: null };
  if (/bank_account_limit_reached/.test(message)) return { error: `${scope}: maksimum 2 rekening bank`, success: null };
  if (/invalid_bank_account/.test(message)) return { error: `${scope}: data rekening tidak lengkap`, success: null };
  if (/bank_account_not_found/.test(message)) return { error: `${scope}: rekening tidak ditemukan`, success: null };
  if (/logo_attachment_not_found/.test(message)) return { error: `${scope}: logo tidak ditemukan`, success: null };
  return { error: `${scope}: server tidak dapat memproses permintaan. Coba lagi.`, success: null };
}

interface DocumentsSettings {
  tagline: string | null; logo_attachment_id: string | null; membership_terms: string | null;
  whatsapp_templates?: { paid_completion?: string | null; outstanding?: string | null; subscription_billing?: string | null };
}

/**
 * app.update_invoice_document_settings REPLACES the whole `documents` jsonb
 * object every call (it has no partial-update mode) — so any action that
 * changes ONE field must read the rest back first, or it silently clobbers
 * the others. This is exactly the bug the logo field had: every tagline/
 * template save used to hardcode p_logo_attachment: null, wiping out
 * whatever logo was set.
 */
async function loadCurrentDocumentsSettings(context: NonNullable<Awaited<ReturnType<typeof workspace>>>): Promise<DocumentsSettings> {
  const org = await context.supabase.from("organizations").select("settings").eq("id", context.organizationId).single();
  const documents = (org.data?.settings as { documents?: DocumentsSettings } | null)?.documents;
  return documents ?? { tagline: null, logo_attachment_id: null, membership_terms: null };
}

export async function updateInvoiceDocumentSettingsAction(_previous: DocumentSettingsActionState, formData: FormData): Promise<DocumentSettingsActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const tagline = String(formData.get("tagline") ?? "").trim();
  const membershipTerms = String(formData.get("membershipTerms") ?? "").trim();
  const waPaid = String(formData.get("waPaidTemplate") ?? "").trim();
  const waOutstanding = String(formData.get("waOutstandingTemplate") ?? "").trim();
  const waSubscription = String(formData.get("waSubscriptionTemplate") ?? "").trim();
  const current = await loadCurrentDocumentsSettings(context);
  const result = await context.supabase.schema("app").rpc("update_invoice_document_settings", {
    p_tagline: tagline || null, p_logo_attachment: current.logo_attachment_id, p_membership_terms: membershipTerms || null,
    p_wa_paid_template: waPaid || null, p_wa_outstanding_template: waOutstanding || null, p_wa_subscription_template: waSubscription || null,
  });
  if (result.error) return mapError("Pengaturan dokumen", result.error.message);
  revalidatePath("/settings/documents"); revalidatePath("/invoices");
  return { error: null, success: "Pengaturan dokumen invoice disimpan." };
}

const LOGO_MIME_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const LOGO_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Upload/replace/remove the org brand logo. A replace uploads the new file
 * FIRST, switches organizations.settings to point at it, and only THEN
 * soft-deletes the previous attachment + removes its storage object — so a
 * failed upload or a failed settings write never leaves the org with no
 * logo at all, and a successful replace never leaves two live copies.
 */
export async function updateInvoiceLogoAction(_previous: DocumentSettingsActionState, formData: FormData): Promise<DocumentSettingsActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const intent = String(formData.get("intent") ?? "upload");
  const current = await loadCurrentDocumentsSettings(context);

  let newLogoAttachmentId: string | null = null;
  let uploadedPath: string | null = null;
  if (intent === "upload") {
    const file = formData.get("logo");
    if (!(file instanceof File) || file.size === 0) return { error: "Logo: pilih file terlebih dahulu", success: null };
    const extension = LOGO_MIME_EXTENSIONS[file.type];
    if (!extension) return { error: "Logo: format harus JPG, PNG, atau WebP", success: null };
    if (file.size > LOGO_MAX_BYTES) return { error: "Logo: ukuran maksimum 1 MB", success: null };
    uploadedPath = `${context.organizationId}/branding/${crypto.randomUUID()}.${extension}`;
    const upload = await context.supabase.storage.from("attachments").upload(uploadedPath, file, { contentType: file.type, upsert: false });
    if (upload.error) return { error: `Logo gagal diunggah: ${upload.error.message}`, success: null };
    const attachment = await context.supabase.from("attachments").insert({
      organization_id: context.organizationId, storage_bucket: "attachments", storage_path: uploadedPath,
      filename: file.name.slice(0, 200) || `logo.${extension}`, mime_type: file.type, size_bytes: file.size,
      uploaded_by: context.userId, metadata: { category: "brand_logo" },
    }).select("id").single();
    if (attachment.error || !attachment.data) {
      await context.supabase.storage.from("attachments").remove([uploadedPath]);
      return { error: "Logo: metadata gagal disimpan", success: null };
    }
    newLogoAttachmentId = attachment.data.id;
  } else if (intent !== "remove") {
    return { error: "Logo: aksi tidak dikenal", success: null };
  }

  const result = await context.supabase.schema("app").rpc("update_invoice_document_settings", {
    p_tagline: current.tagline, p_logo_attachment: newLogoAttachmentId, p_membership_terms: current.membership_terms,
    p_wa_paid_template: current.whatsapp_templates?.paid_completion ?? null,
    p_wa_outstanding_template: current.whatsapp_templates?.outstanding ?? null,
    p_wa_subscription_template: current.whatsapp_templates?.subscription_billing ?? null,
  });
  if (result.error) {
    if (uploadedPath) { await context.supabase.storage.from("attachments").remove([uploadedPath]); await context.supabase.from("attachments").delete().eq("organization_id", context.organizationId).eq("id", newLogoAttachmentId as string); }
    return mapError("Logo", result.error.message);
  }

  if (current.logo_attachment_id && current.logo_attachment_id !== newLogoAttachmentId) {
    const previous = await context.supabase.from("attachments").select("storage_path").eq("organization_id", context.organizationId).eq("id", current.logo_attachment_id).maybeSingle();
    await context.supabase.from("attachments").update({ deleted_at: new Date().toISOString() }).eq("organization_id", context.organizationId).eq("id", current.logo_attachment_id);
    if (previous.data?.storage_path) await context.supabase.storage.from("attachments").remove([previous.data.storage_path]);
  }

  revalidatePath("/settings/documents"); revalidatePath("/invoices");
  return { error: null, success: intent === "remove" ? "Logo dihapus." : "Logo disimpan." };
}

export async function upsertBankAccountAction(_previous: DocumentSettingsActionState, formData: FormData): Promise<DocumentSettingsActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const idRaw = String(formData.get("id") ?? "").trim();
  const bankName = String(formData.get("bankName") ?? "").trim();
  const accountNumber = String(formData.get("accountNumber") ?? "").trim();
  const accountHolder = String(formData.get("accountHolder") ?? "").trim();
  const isPrimary = formData.get("isPrimary") === "true";
  const result = await context.supabase.schema("app").rpc("upsert_organization_bank_account", {
    p_id: idRaw || null, p_bank_name: bankName, p_account_number: accountNumber, p_account_holder: accountHolder, p_is_primary: isPrimary, p_sort_order: 0,
  });
  if (result.error) return mapError("Rekening bank", result.error.message);
  revalidatePath("/settings/documents"); revalidatePath("/invoices");
  return { error: null, success: "Rekening bank disimpan." };
}

export async function deleteBankAccountAction(_previous: DocumentSettingsActionState, formData: FormData): Promise<DocumentSettingsActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Rekening bank: ID tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("delete_organization_bank_account", { p_id: id });
  if (result.error) return mapError("Rekening bank", result.error.message);
  revalidatePath("/settings/documents"); revalidatePath("/invoices");
  return { error: null, success: "Rekening bank dihapus." };
}

export async function updateInvoiceCustomerNotesAction(_previous: DocumentSettingsActionState, formData: FormData): Promise<DocumentSettingsActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const revision = Number(formData.get("revision"));
  const notes = String(formData.get("notes") ?? "").trim();
  if (!invoiceId || !Number.isFinite(revision)) return { error: "Catatan groomer: data tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("update_invoice_customer_notes", { p_invoice: invoiceId, p_revision: revision, p_customer_notes: notes || null });
  if (result.error) {
    if (/invoice_locked/.test(result.error.message)) return { error: "Catatan groomer: invoice sudah dikunci (lunas/dibatalkan)", success: null };
    if (/stale_invoice/.test(result.error.message)) return { error: "Catatan groomer: data sudah berubah, muat ulang halaman", success: null };
    return { error: "Catatan groomer: server tidak dapat memproses permintaan", success: null };
  }
  revalidatePath(`/invoices/${invoiceId}`);
  return { error: null, success: "Catatan untuk pelanggan disimpan." };
}
