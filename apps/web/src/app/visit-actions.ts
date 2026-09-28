"use server";

/**
 * Section 30 visit-register actions: manual visit CRUD, manual billing +
 * undo, invoice linking, and the auto-log setting. Kept separate from
 * pilot-actions.ts - this is new surface, not an extension of an existing
 * loader/action.
 */
import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export interface VisitActionState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function workspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return null;
  return { supabase, organizationId: context.activeOrganization.id, userId: context.user.id };
}

function mapError(scope: string, message: string): VisitActionState {
  if (/not_authorized/.test(message)) return { error: `${scope}: Anda tidak memiliki akses untuk aksi ini`, success: null };
  if (/customer_not_found/.test(message)) return { error: `${scope}: pelanggan tidak ditemukan`, success: null };
  if (/pet_not_found_for_customer/.test(message)) return { error: `${scope}: hewan tidak terdaftar untuk pelanggan ini`, success: null };
  if (/visit_not_found/.test(message)) return { error: `${scope}: kunjungan tidak ditemukan`, success: null };
  if (/visit_has_invoice/.test(message)) return { error: `${scope}: kunjungan ini sudah memiliki invoice, tidak bisa dihapus`, success: null };
  if (/visit_has_active_manual_billing/.test(message)) return { error: `${scope}: batalkan penagihan manual dulu sebelum melanjutkan`, success: null };
  if (/visit_already_invoiced/.test(message)) return { error: `${scope}: kunjungan ini sudah memiliki invoice aktif`, success: null };
  if (/already_manually_billed/.test(message)) return { error: `${scope}: kunjungan ini sudah ditandai tertagih manual`, success: null };
  if (/booking_not_completed/.test(message)) return { error: `${scope}: booking ini belum selesai`, success: null };
  if (/already_undone/.test(message)) return { error: `${scope}: penagihan ini sudah dibatalkan sebelumnya`, success: null };
  if (/invoice_customer_mismatch/.test(message)) return { error: `${scope}: invoice ini milik pelanggan lain`, success: null };
  if (/invoice_void/.test(message)) return { error: `${scope}: invoice ini sudah dibatalkan`, success: null };
  return { error: `${scope}: server tidak dapat memproses permintaan. Coba lagi.`, success: null };
}

export async function createManualVisitAction(_previous: VisitActionState, formData: FormData): Promise<VisitActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const branchId = String(formData.get("branchId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const petIdRaw = String(formData.get("petId") ?? "");
  const petId = UUID.test(petIdRaw) ? petIdRaw : null;
  const fulfillmentMode = String(formData.get("fulfillmentMode") ?? "in_store");
  const visitAtRaw = String(formData.get("visitAt") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!UUID.test(branchId) || !UUID.test(customerId) || !visitAtRaw || !description) return { error: "Kunjungan manual: data tidak valid", success: null };
  const visitAt = new Date(visitAtRaw);
  if (Number.isNaN(visitAt.getTime())) return { error: "Kunjungan manual: tanggal tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("create_manual_visit", {
    p_branch: branchId, p_customer: customerId, p_pet: petId, p_fulfillment_mode: fulfillmentMode,
    p_visit_at: visitAt.toISOString(), p_description: description, p_note: note || null,
  });
  if (result.error) return mapError("Kunjungan manual", result.error.message);
  revalidatePath("/visits");
  return { error: null, success: "Kunjungan manual berhasil dicatat." };
}

export async function deleteManualVisitAction(_previous: VisitActionState, formData: FormData): Promise<VisitActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const visitId = String(formData.get("visitId") ?? "");
  if (!UUID.test(visitId)) return { error: "Hapus kunjungan: ID tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("delete_manual_visit", { p_visit: visitId });
  if (result.error) return mapError("Hapus kunjungan", result.error.message);
  revalidatePath("/visits");
  return { error: null, success: "Kunjungan manual dihapus." };
}

export async function markVisitManuallyBilledAction(_previous: VisitActionState, formData: FormData): Promise<VisitActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const sourceType = String(formData.get("sourceType") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");
  const amount = Number(formData.get("amount"));
  const note = String(formData.get("note") ?? "").trim();
  if ((sourceType !== "booking" && sourceType !== "manual_visit") || !UUID.test(sourceId) || !Number.isFinite(amount) || amount <= 0) {
    return { error: "Tandai tertagih manual: data tidak valid", success: null };
  }
  const result = await context.supabase.schema("app").rpc("mark_visit_manually_billed", { p_source_type: sourceType, p_source_id: sourceId, p_amount: amount, p_note: note || null });
  if (result.error) return mapError("Tandai tertagih manual", result.error.message);
  revalidatePath("/visits"); revalidatePath("/dashboard");
  return { error: null, success: "Kunjungan ditandai tertagih manual." };
}

export async function undoManualBillingAction(_previous: VisitActionState, formData: FormData): Promise<VisitActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const billingId = String(formData.get("billingId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!UUID.test(billingId)) return { error: "Batalkan penagihan manual: ID tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("undo_manual_billing", { p_billing: billingId, p_note: note || null });
  if (result.error) return mapError("Batalkan penagihan manual", result.error.message);
  revalidatePath("/visits"); revalidatePath("/dashboard");
  return { error: null, success: "Penagihan manual dibatalkan." };
}

export async function createInvoiceFromManualVisitAction(_previous: VisitActionState, formData: FormData): Promise<VisitActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const visitId = String(formData.get("visitId") ?? "");
  const amount = Number(formData.get("amount"));
  const requestKey = String(formData.get("requestKey") ?? "");
  const adminNotes = String(formData.get("adminNotes") ?? "").trim();
  if (!UUID.test(visitId) || !Number.isFinite(amount) || amount <= 0 || !UUID.test(requestKey)) return { error: "Buat invoice dari kunjungan: data tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("create_invoice_from_manual_visit", {
    p_visit: visitId, p_issued_at: new Date().toISOString(), p_due_at: null, p_amount: amount, p_admin_notes: adminNotes || null, p_request_key: requestKey,
  });
  if (result.error) return mapError("Buat invoice dari kunjungan", result.error.message);
  revalidatePath("/visits"); revalidatePath("/finance");
  return { error: null, success: "Invoice berhasil dibuat dari kunjungan." };
}

export async function setVisitAutoLogEnabledAction(_previous: VisitActionState, formData: FormData): Promise<VisitActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const enabled = formData.get("enabled") === "true";
  const result = await context.supabase.schema("app").rpc("set_visit_auto_log_enabled", { p_enabled: enabled });
  if (result.error) return mapError("Pengaturan pencatatan otomatis", result.error.message);
  revalidatePath("/visits");
  return { error: null, success: enabled ? "Pencatatan otomatis diaktifkan." : "Pencatatan otomatis dimatikan." };
}
