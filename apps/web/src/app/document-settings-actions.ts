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
  return { error: `${scope}: server tidak dapat memproses permintaan. Coba lagi.`, success: null };
}

export async function updateInvoiceDocumentSettingsAction(_previous: DocumentSettingsActionState, formData: FormData): Promise<DocumentSettingsActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const tagline = String(formData.get("tagline") ?? "").trim();
  const membershipTerms = String(formData.get("membershipTerms") ?? "").trim();
  const waPaid = String(formData.get("waPaidTemplate") ?? "").trim();
  const waOutstanding = String(formData.get("waOutstandingTemplate") ?? "").trim();
  const waSubscription = String(formData.get("waSubscriptionTemplate") ?? "").trim();
  const result = await context.supabase.schema("app").rpc("update_invoice_document_settings", {
    p_tagline: tagline || null, p_logo_attachment: null, p_membership_terms: membershipTerms || null,
    p_wa_paid_template: waPaid || null, p_wa_outstanding_template: waOutstanding || null, p_wa_subscription_template: waSubscription || null,
  });
  if (result.error) return mapError("Pengaturan dokumen", result.error.message);
  revalidatePath("/settings/documents"); revalidatePath("/invoices");
  return { error: null, success: "Pengaturan dokumen invoice disimpan." };
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
