"use server";

/**
 * Section 29 payment review actions. Kept separate from pilot-actions.ts —
 * this is new surface (the admin-controlled screenshot/bank-validation
 * workflow), not an extension of the existing manual-payment recording.
 */
import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export interface PaymentActionState { error: string | null; success: string | null }

async function workspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return null;
  return { supabase, organizationId: context.activeOrganization.id, userId: context.user.id };
}

function mapRpcError(message: string): string {
  if (/invalid_stage_transition/.test(message)) return "tahap pembayaran ini belum siap untuk langkah tersebut";
  if (/proof_required/.test(message)) return "bukti transfer belum diunggah untuk pembayaran ini";
  if (/not_authorized/.test(message)) return "Anda tidak memiliki akses untuk aksi ini";
  if (/payment_not_found/.test(message)) return "pembayaran tidak ditemukan";
  return "server tidak dapat memproses permintaan. Coba lagi.";
}

export async function confirmPaymentScreenshotAction(_previous: PaymentActionState, formData: FormData): Promise<PaymentActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const paymentId = String(formData.get("paymentId") ?? "");
  if (!paymentId) return { error: "Konfirmasi screenshot: ID pembayaran tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("confirm_payment_screenshot", { p_payment: paymentId });
  if (result.error) return { error: `Konfirmasi screenshot gagal: ${mapRpcError(result.error.message)}`, success: null };
  revalidatePath("/finance");
  return { error: null, success: "Screenshot pembayaran dikonfirmasi." };
}

export async function validatePaymentBankAccountAction(_previous: PaymentActionState, formData: FormData): Promise<PaymentActionState> {
  const context = await workspace(); if (!context) return { error: "Sesi: workspace aktif tidak tersedia", success: null };
  const paymentId = String(formData.get("paymentId") ?? "");
  if (!paymentId) return { error: "Validasi rekening: ID pembayaran tidak valid", success: null };
  const result = await context.supabase.schema("app").rpc("validate_payment_bank_account", { p_payment: paymentId });
  if (result.error) return { error: `Validasi rekening gagal: ${mapRpcError(result.error.message)}`, success: null };
  revalidatePath("/finance");
  return { error: null, success: "Rekening bank untuk pembayaran ini divalidasi." };
}
