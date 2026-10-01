"use server";

import { revalidatePath } from "next/cache";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export type SizeBoundaryState = { error: string | null; success: string | null };

export async function saveSizeBandsAction(_state: SizeBoundaryState, data: FormData): Promise<SizeBoundaryState> {
  const workspace = await requireActiveWorkspace();
  let bands: Array<{ key: string; label: string; upperKg: number | null }>;
  try {
    const parsed: unknown = JSON.parse(String(data.get("bandsJson") ?? ""));
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) throw new Error("invalid_bands");
    bands = parsed.map((row, index) => {
      if (!row || typeof row !== "object") throw new Error("invalid_band");
      const entry = row as Record<string, unknown>;
      const key = String(entry.key ?? "").trim(); const label = String(entry.label ?? "").trim();
      const upperKg = index === parsed.length - 1 ? null : Number(entry.upperKg);
      if (!/^[a-z][a-z0-9_]{1,29}$/.test(key) || label.length < 1 || label.length > 24
        || (index < parsed.length - 1 && (upperKg === null || !Number.isFinite(upperKg) || upperKg <= 0 || upperKg > 999))) throw new Error("invalid_band");
      return { key, label, upperKg };
    });
    if (new Set(bands.map((band) => band.key)).size !== bands.length
      || bands.slice(0, -2).some((band, index) => Number(band.upperKg) >= Number(bands[index + 1].upperKg))) throw new Error("invalid_order");
  } catch { return { error: "Periksa kode, nama, dan batas KG. Kode harus unik dan batas harus naik berurutan.", success: null }; }
  const result = await workspace.supabase.schema("app").rpc("replace_dog_size_bands", { p_org: workspace.activeOrganization.id, p_bands: bands });
  if (result.error) {
    const reason = result.error.message;
    if (reason.includes("active_package_size_would_change")) return { error: "Perubahan batas akan mengubah ukuran pet yang memiliki paket aktif. Selesaikan paket itu dahulu.", success: null };
    if (reason.includes("band_has_package")) return { error: "Ukuran ini masih dipakai paket aktif atau saldo pelanggan. Arsipkan paket dan selesaikan saldo sebelum menghapusnya.", success: null };
    if (reason.includes("band_has_unmeasured_pet")) return { error: "Ukuran ini masih dipakai pet tanpa berat badan. Isi berat atau ubah ukuran pet tersebut dahulu.", success: null };
    return { error: "Kategori ukuran belum tersimpan. Periksa batas dan izin pemilik bisnis.", success: null };
  }
  revalidatePath("/catalog");
  revalidatePath("/customers");
  revalidatePath("/schedule");
  revalidatePath("/bookings"); revalidatePath("/programs"); revalidatePath("/payroll");
  return { error: null, success: "Kategori ukuran tersimpan. Pet terukur diperbarui; invoice dan payroll lama tetap memakai snapshot." };
}
