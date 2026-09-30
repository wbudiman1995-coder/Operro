"use server";

import { revalidatePath } from "next/cache";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export type SizeBoundaryState = { error: string | null; success: string | null };

export async function saveSizeBoundariesAction(_state: SizeBoundaryState, data: FormData): Promise<SizeBoundaryState> {
  const workspace = await requireActiveWorkspace();
  const values = ["xs", "s", "m", "l"].map(key => Number(data.get(key)));
  if (values.some(value => !Number.isFinite(value) || value <= 0 || value > 999) || !(values[0] < values[1] && values[1] < values[2] && values[2] < values[3])) {
    return { error: "Batas harus berurutan: XS < S < M < L, semuanya lebih dari 0 kg.", success: null };
  }
  const result = await workspace.supabase.schema("app").rpc("set_dog_size_boundaries", { p_org: workspace.activeOrganization.id, p_xs: values[0], p_s: values[1], p_m: values[2], p_l: values[3] });
  if (result.error) return { error: result.error.message.includes("active_package_size_would_change") ? "Ada paket ukuran aktif yang akan berubah kategori. Selesaikan atau tinjau paket itu sebelum mengubah batas." : "Batas ukuran belum tersimpan. Hanya pemilik bisnis yang dapat mengubahnya.", success: null };
  revalidatePath("/catalog");
  revalidatePath("/customers");
  revalidatePath("/schedule");
  return { error: null, success: "Batas ukuran tersimpan. Ukuran pet terukur diperbarui; booking dan invoice lama tetap memakai snapshot sebelumnya." };
}
