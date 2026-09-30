"use server";

import { revalidatePath } from "next/cache";
import { requireActiveWorkspace } from "@/lib/require-workspace";

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
  const workspace = await requireActiveWorkspace();
  const usage = await workspace.supabase.schema("app").rpc("storage_usage_snapshot");
  if (usage.error || !(usage.data as Record<string, unknown> | null)?.is_platform_admin) return { error: "Hanya admin platform yang dapat meninjau permintaan.", success: null };
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || !["contacted", "fulfilled", "declined"].includes(status)) return { error: "Permintaan atau status tidak valid.", success: null };
  const { data, error } = await workspace.supabase.from("storage_upgrade_requests").update({ status, reviewed_by: workspace.userId, reviewed_at: new Date().toISOString() }).eq("id", id).in("status", ["requested", "contacted"]).select("id").maybeSingle();
  if (error || !data) return { error: "Status belum tersimpan atau permintaan sudah berubah.", success: null };
  revalidatePath("/settings/storage");
  return { error: null, success: "Status permintaan diperbarui." };
}
