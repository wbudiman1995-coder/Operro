"use server";

import { revalidatePath } from "next/cache";
import { loadCapabilities } from "@/lib/authorization";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface StylingReferenceActionState { error: string | null; success: string | null }
const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const expiryDays = new Set([30, 90, 180, 365]);

export async function uploadStylingReferenceAction(_previous: StylingReferenceActionState, formData: FormData): Promise<StylingReferenceActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const capabilities = await loadCapabilities(workspace.supabase);
    if (!capabilities["customer.manage"]) return { error: "Anda tidak memiliki izin mengelola pelanggan.", success: null };
    const customerId = String(formData.get("customerId") ?? "");
    const petId = String(formData.get("petId") ?? "");
    const caption = String(formData.get("caption") ?? "").trim().slice(0, 300);
    const days = Number(formData.get("expiryDays") ?? 180);
    const file = formData.get("photo");
    if (!customerId || !petId || !expiryDays.has(days)) return { error: "Data referensi tidak valid.", success: null };
    if (!(file instanceof File) || file.size === 0) return { error: "Pilih foto terlebih dahulu.", success: null };
    const extension = extensions[file.type];
    if (!extension) return { error: "Format harus JPG, PNG, atau WebP.", success: null };
    if (file.size > 4 * 1024 * 1024) return { error: "Ukuran maksimum 4 MB setelah kompresi.", success: null };

    const pet = await workspace.supabase.from("pets").select("id").eq("organization_id", workspace.activeOrganization.id).eq("customer_id", customerId).eq("id", petId).is("deleted_at", null).maybeSingle();
    if (pet.error || !pet.data) return { error: "Hewan tidak ditemukan pada pelanggan ini.", success: null };

    const storagePath = `${workspace.activeOrganization.id}/customers/${customerId}/${petId}/${crypto.randomUUID()}.${extension}`;
    const upload = await workspace.supabase.storage.from("styling-references").upload(storagePath, file, { contentType: file.type, upsert: false });
    if (upload.error) return { error: `Foto gagal diunggah: ${upload.error.message}`, success: null };
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    const attachment = await workspace.supabase.from("attachments").insert({
      organization_id: workspace.activeOrganization.id,
      storage_bucket: "styling-references",
      storage_path: storagePath,
      filename: file.name.slice(0, 200) || `referensi.${extension}`,
      mime_type: file.type,
      size_bytes: file.size,
      uploaded_by: workspace.userId,
      metadata: { kind: "styling_reference", customer_id: customerId, pet_id: petId, caption, expires_at: expiresAt },
    }).select("id").single();
    if (attachment.error || !attachment.data) {
      await workspace.supabase.storage.from("styling-references").remove([storagePath]);
      return { error: "Metadata foto gagal disimpan.", success: null };
    }
    const link = await workspace.supabase.from("attachment_links").insert({ organization_id: workspace.activeOrganization.id, attachment_id: attachment.data.id, subject_type: "pet", subject_id: petId });
    if (link.error) {
      await workspace.supabase.from("attachments").delete().eq("organization_id", workspace.activeOrganization.id).eq("id", attachment.data.id);
      await workspace.supabase.storage.from("styling-references").remove([storagePath]);
      return { error: "Foto gagal ditautkan ke hewan.", success: null };
    }
    revalidatePath(`/customers/${customerId}`); revalidatePath("/my-schedule");
    return { error: null, success: "Referensi gaya berhasil disimpan." };
  } catch (error) {
    console.error("upload_styling_reference_failed", error);
    return { error: "Referensi gaya tidak dapat disimpan.", success: null };
  }
}

export async function deleteStylingReferenceAction(formData: FormData) {
  const workspace = await requireActiveWorkspace();
  const capabilities = await loadCapabilities(workspace.supabase);
  if (!capabilities["customer.manage"]) return;
  const attachmentId = String(formData.get("attachmentId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  if (!attachmentId || !customerId) return;
  const row = await workspace.supabase.from("attachments").select("id,storage_path,storage_bucket,metadata").eq("organization_id", workspace.activeOrganization.id).eq("id", attachmentId).eq("storage_bucket", "styling-references").is("deleted_at", null).maybeSingle();
  const metadata = row.data?.metadata && typeof row.data.metadata === "object" && !Array.isArray(row.data.metadata) ? row.data.metadata as Record<string, unknown> : {};
  if (row.error || !row.data || metadata.kind !== "styling_reference" || metadata.customer_id !== customerId) return;
  await workspace.supabase.from("attachments").update({ deleted_at: new Date().toISOString() }).eq("organization_id", workspace.activeOrganization.id).eq("id", attachmentId);
  await workspace.supabase.storage.from(row.data.storage_bucket).remove([row.data.storage_path]);
  revalidatePath(`/customers/${customerId}`); revalidatePath("/my-schedule");
}

