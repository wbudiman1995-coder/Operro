"use server";

import { revalidatePath } from "next/cache";
import { loadAuthContext } from "@/lib/auth-context";
import { EVIDENCE_RETENTION_MAX, EVIDENCE_RETENTION_MIN, parseEvidenceRetentionDays } from "@/lib/preferences";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { createClient } from "@/lib/supabase/server";

export interface StorageActionState { error: string | null; success: string | null }

export async function requestStorageUpgradeAction(_previous: StorageActionState, formData: FormData): Promise<StorageActionState> {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["settings.manage"]) return { error: "Hanya pemilik/pengelola pengaturan yang dapat meminta kapasitas.", success: null };
  const requestedGb = Number(formData.get("requestedGb"));
  const note = String(formData.get("note") ?? "").trim().slice(0, 1000);
  if (![1, 5, 10, 25, 50, 100].includes(requestedGb)) return { error: "Pilih jumlah kapasitas yang tersedia.", success: null };
  const { error } = await workspace.supabase.from("storage_upgrade_requests").insert({ organization_id: workspace.activeOrganization.id, requested_gb: requestedGb, note: note || null, created_by: workspace.userId });
  if (error) return { error: error.code === "23505" ? "Masih ada permintaan aktif untuk workspace ini." : "Permintaan belum tersimpan. Coba lagi.", success: null };
  revalidatePath("/settings/storage");
  return { error: null, success: "Permintaan diterima. Admin Operro akan menghubungi Anda untuk harga dan pembayaran manual. Belum ada tagihan." };
}

export async function reviewStorageUpgradeAction(_previous: StorageActionState, formData: FormData): Promise<StorageActionState> {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  const owner = context ? await supabase.schema("app").rpc("is_operro_owner") : null;
  if (!owner || owner.error || owner.data !== true) return { error: "Hanya pemilik Operro yang dapat meninjau permintaan.", success: null };
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || !["contacted", "fulfilled", "declined"].includes(status)) return { error: "Permintaan atau status tidak valid.", success: null };
  const { data, error } = await supabase.from("storage_upgrade_requests").update({ status, reviewed_by: context!.user.id, reviewed_at: new Date().toISOString() }).eq("id", id).in("status", ["requested", "contacted"]).select("id").maybeSingle();
  if (error || !data) return { error: "Status belum tersimpan atau permintaan sudah berubah.", success: null };
  revalidatePath("/settings/storage");
  revalidatePath("/platform");
  return { error: null, success: "Status permintaan diperbarui." };
}

/** Organization-owned setting (business owner only; the RPC re-checks). Affects evidence uploaded afterwards. */
export async function saveEvidenceRetentionAction(_previous: StorageActionState, formData: FormData): Promise<StorageActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const values = formData.getAll("days");
    const days = values.length === 1 ? parseEvidenceRetentionDays(values[0]) : undefined;
    if (days === undefined) return { error: `Isi bilangan bulat ${EVIDENCE_RETENTION_MIN}–${EVIDENCE_RETENTION_MAX} hari.`, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_evidence_retention_days", { p_days: days });
    if (error) {
      console.error("evidence_retention_save_failed", error);
      if (error.code === "42501") return { error: "Hanya pemilik bisnis yang dapat mengubah masa simpan foto.", success: null };
      if (error.code === "22023") return { error: `Isi bilangan bulat ${EVIDENCE_RETENTION_MIN}–${EVIDENCE_RETENTION_MAX} hari.`, success: null };
      return { error: "Pengaturan belum tersimpan. Coba lagi.", success: null };
    }
    revalidatePath("/settings/storage");
    return { error: null, success: "Masa simpan foto disimpan. Berlaku untuk foto yang diunggah setelah ini." };
  } catch (error) {
    console.error("evidence_retention_save_unexpected", error);
    return { error: "Pengaturan belum tersimpan. Coba lagi.", success: null };
  }
}
