"use server";

import { revalidatePath } from "next/cache";

import { previewStorageCleanup, runStorageCleanup, type CleanupPreview, type CleanupSummary } from "@/lib/storage-cleanup";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface CleanupPreviewState { error: string | null; preview: CleanupPreview | null }
export interface CleanupApplyState { error: string | null; summary: CleanupSummary | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (text.includes(":42501:")) return "Hanya pemilik bisnis yang dapat menjalankan pembersihan; pengelola pengaturan dapat membuat pratinjau.";
  if (text.includes(":55P03:")) return "Pembersihan lain sedang berjalan untuk bisnis ini. Tunggu hingga selesai.";
  if (text.includes(":22023:")) return "Pratinjau sudah lebih dari 24 jam. Buat pratinjau baru.";
  if (text.includes(":P0002:")) return "Pratinjau tidak ditemukan. Buat pratinjau baru.";
  return "Pembersihan belum dapat diproses. Tidak ada hasil parsial yang dilaporkan sebagai sukses.";
}

/** Dry run: lists candidates and changes nothing except its own bookkeeping row. */
export async function previewStorageCleanupAction(): Promise<CleanupPreviewState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["settings.manage"]) return { error: "Anda tidak memiliki izin mengelola pengaturan.", preview: null };
    const preview = await previewStorageCleanup(workspace.supabase, workspace.activeOrganization.id);
    revalidatePath("/settings/storage");
    return { error: null, preview };
  } catch (error) {
    console.error("storage_cleanup_preview_failed", error);
    return { error: describe(error), preview: null };
  }
}

/** Apply the previewed set. The business owner is re-checked inside the database. */
export async function applyStorageCleanupAction(_previous: CleanupApplyState, formData: FormData): Promise<CleanupApplyState> {
  try {
    const workspace = await requireActiveWorkspace();
    const values = formData.getAll("previewId");
    if (values.length !== 1 || typeof values[0] !== "string" || !UUID.test(values[0])) return { error: "Pratinjau tidak valid.", summary: null };
    if (formData.get("confirm") !== "yes") return { error: "Centang konfirmasi sebelum menjalankan pembersihan.", summary: null };
    const summary = await runStorageCleanup(workspace.supabase, values[0]);
    revalidatePath("/settings/storage");
    return { error: summary.error ? "Sebagian proses terhenti; objek yang belum selesai akan dicoba lagi pada proses berikutnya." : null, summary };
  } catch (error) {
    console.error("storage_cleanup_apply_failed", error);
    return { error: describe(error), summary: null };
  }
}
