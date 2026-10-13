"use server";

import { revalidatePath } from "next/cache";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { isValidLayoutPayload, mapSizeBandError, parseImpact, type LayoutImpact, type LayoutPayloadBand } from "@/lib/size-bands";

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

// ---------------------------------------------------------------------------
// Dynamic size bands (SB-05). Every call below only forwards to a SECURITY
// DEFINER RPC that re-derives authority, tenant, locking and validation in SQL.
// ---------------------------------------------------------------------------

export type SizeBandActionResult =
  | { ok: true; message: string; layoutVersion: number; impact: LayoutImpact | null; newBands: Array<{ key: string; label: string }> }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID: SizeBandActionResult = { ok: false, error: "Permintaan tidak valid. Muat ulang halaman lalu coba lagi." };

function validVersion(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 2_000_000_000; }

function refreshAfterLayoutChange() {
  for (const path of ["/catalog", "/customers", "/programs", "/bookings", "/schedule", "/invoices/new"]) revalidatePath(path);
}

function layoutResult(data: unknown, message: string): SizeBandActionResult {
  const value = (data ?? {}) as Record<string, unknown>;
  const newBands = Array.isArray(value.new_bands) ? (value.new_bands as Array<Record<string, unknown>>).map((band) => ({ key: String(band.key), label: String(band.label) })) : [];
  return { ok: true, message, layoutVersion: Number(value.layout_version ?? 0), impact: parseImpact(value.impact), newBands };
}

/** Read-only impact of a draft layout; the same SQL plan that save uses. Writes nothing. */
export async function previewSizeLayoutAction(input: { bands: LayoutPayloadBand[] }): Promise<SizeBandActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!input || !isValidLayoutPayload(input.bands)) return INVALID;
  const result = await workspace.supabase.schema("app").rpc("preview_size_layout_impact", { p_org: workspace.activeOrganization.id, p_bands: input.bands });
  if (result.error) return { ok: false, error: mapSizeBandError(result.error) };
  return layoutResult(result.data, "Pratinjau dihitung. Tidak ada data yang diubah.");
}

export async function saveSizeBandsAction(input: { version: number; bands: LayoutPayloadBand[] }): Promise<SizeBandActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!input || !validVersion(input.version) || !isValidLayoutPayload(input.bands)) return INVALID;
  const result = await workspace.supabase.schema("app").rpc("save_size_bands", { p_org: workspace.activeOrganization.id, p_expected_version: input.version, p_bands: input.bands });
  if (result.error) return { ok: false, error: mapSizeBandError(result.error) };
  refreshAfterLayoutChange();
  const changed = (result.data as { changed?: boolean } | null)?.changed !== false;
  return layoutResult(result.data, changed ? "Kategori ukuran tersimpan. Anjing terukur dipindahkan otomatis; booking, invoice, dan paket lama tetap memakai snapshot-nya." : "Tidak ada perubahan.");
}

export async function archiveSizeBandAction(input: { version: number; bandId: string }): Promise<SizeBandActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!input || !validVersion(input.version) || typeof input.bandId !== "string" || !UUID.test(input.bandId)) return INVALID;
  const result = await workspace.supabase.schema("app").rpc("archive_size_band", { p_org: workspace.activeOrganization.id, p_expected_version: input.version, p_band: input.bandId });
  if (result.error) return { ok: false, error: mapSizeBandError(result.error) };
  refreshAfterLayoutChange();
  return layoutResult(result.data, "Kategori diarsipkan. Rentangnya diserap kategori terdekat; riwayat lama tetap terbaca.");
}

export async function deleteSizeBandAction(input: { version: number; bandId: string }): Promise<SizeBandActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!input || !validVersion(input.version) || typeof input.bandId !== "string" || !UUID.test(input.bandId)) return INVALID;
  const result = await workspace.supabase.schema("app").rpc("delete_size_band", { p_org: workspace.activeOrganization.id, p_expected_version: input.version, p_band: input.bandId });
  if (result.error) return { ok: false, error: mapSizeBandError(result.error) };
  refreshAfterLayoutChange();
  return layoutResult(result.data, "Kategori dihapus permanen.");
}

/** Business owner only (enforced in SQL) and only for the tenant that is currently selected. */
export async function setSizeBandModeAction(input: { version: number; mode: "legacy" | "dynamic" }): Promise<SizeBandActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!input || !validVersion(input.version) || (input.mode !== "legacy" && input.mode !== "dynamic")) return INVALID;
  const result = await workspace.supabase.schema("app").rpc("set_size_band_mode", { p_org: workspace.activeOrganization.id, p_mode: input.mode, p_expected_version: input.version });
  if (result.error) return { ok: false, error: mapSizeBandError(result.error) };
  refreshAfterLayoutChange();
  return layoutResult(result.data, input.mode === "dynamic" ? "Mode kategori dinamis aktif untuk bisnis ini." : "Kembali ke mode batas lama.");
}
