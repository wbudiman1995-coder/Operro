"use server";

import { revalidatePath } from "next/cache";

import { requireActiveWorkspace } from "@/lib/require-workspace";
import { buildDraftMessage } from "@/lib/whatsapp-message-build";
import { isWhatsAppSource, isWhatsAppStatus } from "@/lib/whatsapp-drafts";

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
    const built = await buildDraftMessage(workspace, sourceType, sourceId);
    if (!built.ok) return { error: built.error, success: null };
    const text = built.text;

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
