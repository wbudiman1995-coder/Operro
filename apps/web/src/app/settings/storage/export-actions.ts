"use server";

import { revalidatePath } from "next/cache";

import { cancelOrganizationExport, describeExportError, purgeExportArchive, runOrganizationExportStep, startOrganizationExport, verifyStoredOrganizationExport } from "@/lib/org-export";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export type ExportActionResult = { ok: boolean; jobId?: string; done?: boolean; message: string };

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_JOB: ExportActionResult = { ok: false, done: false, message: "ID export tidak valid." };

// The organization comes from the authenticated session inside every RPC (app.fn_active_organization);
// the browser supplies only a job id, which the database re-checks against that organization.
export async function startOrganizationExportAction(includeStorage: boolean): Promise<ExportActionResult> {
  const workspace = await requireActiveWorkspace();
  try {
    const { jobId, resumed } = await startOrganizationExport(workspace.supabase, includeStorage === true);
    return { ok: true, jobId, done: false, message: resumed ? "Melanjutkan export yang belum selesai." : "Export dimulai." };
  } catch (error) { return { ok: false, done: false, message: describeExportError(error) }; }
}

export async function stepOrganizationExportAction(jobId: string): Promise<ExportActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!JOB_ID.test(jobId)) return INVALID_JOB;
  try {
    const step = await runOrganizationExportStep(workspace.supabase, jobId);
    if (step.done) revalidatePath("/settings/storage");
    return { ok: true, jobId, done: step.done, message: step.message };
  } catch (error) { return { ok: false, jobId, done: false, message: describeExportError(error) }; }
}

export async function cancelOrganizationExportAction(jobId: string): Promise<ExportActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!JOB_ID.test(jobId)) return INVALID_JOB;
  try {
    await cancelOrganizationExport(workspace.supabase, jobId);
    revalidatePath("/settings/storage");
    return { ok: true, jobId, done: true, message: "Export dibatalkan. Berkas yang sudah terunggah tidak dipakai." };
  } catch (error) { return { ok: false, jobId, done: false, message: describeExportError(error) }; }
}

export async function verifyOrganizationExportAction(jobId: string): Promise<ExportActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!JOB_ID.test(jobId)) return INVALID_JOB;
  try {
    const result = await verifyStoredOrganizationExport(workspace.supabase, jobId);
    revalidatePath("/settings/storage");
    const warnings = result.warnings.length ? ` Catatan: ${result.warnings.join(", ")}.` : "";
    return result.ok
      ? { ok: true, jobId, done: true, message: `Verifikasi metadata lulus (hash ${result.manifestSha256?.slice(0, 12)}…).${warnings} Ini bukan uji pemulihan.` }
      : { ok: false, jobId, done: true, message: `Verifikasi gagal: ${result.failures.slice(0, 5).join(", ")}${result.failures.length > 5 ? ` (+${result.failures.length - 5})` : ""}.` };
  } catch (error) { return { ok: false, jobId, done: false, message: describeExportError(error) }; }
}


/** Removes the files of an archive past its retention window (owner only; the database re-checks the rule). Repeat until done. */
export async function purgeOrganizationExportAction(jobId: string): Promise<ExportActionResult> {
  const workspace = await requireActiveWorkspace();
  if (!JOB_ID.test(jobId)) return INVALID_JOB;
  try {
    let removed = 0;
    for (let round = 0; round < 20; round += 1) {
      const step = await purgeExportArchive(workspace.supabase, jobId);
      removed += step.removed;
      if (step.done) {
        revalidatePath("/settings/storage");
        return { ok: true, jobId, done: true, message: `Berkas arsip dihapus dari penyimpanan (${removed} berkas pada langkah ini). Riwayat dan manifest tetap tercatat, tetapi arsip tidak dapat diverifikasi lagi.` };
      }
    }
    return { ok: true, jobId, done: false, message: `${removed} berkas dihapus; masih ada sisa. Tekan hapus lagi untuk melanjutkan.` };
  } catch (error) { return { ok: false, jobId, done: false, message: describeExportError(error) }; }
}
