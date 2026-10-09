"use server";

import { revalidatePath } from "next/cache";

import { cancelOrganizationExport, describeExportError, runOrganizationExportStep, startOrganizationExport, verifyStoredOrganizationExport } from "@/lib/org-export";
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
    const warnings = result.warnings.length ? ` Catatan: ${result.warnings.join(", ")}.` : "";
    return result.ok
      ? { ok: true, jobId, done: true, message: `Verifikasi metadata lulus (hash ${result.manifestSha256?.slice(0, 12)}…).${warnings} Ini bukan uji pemulihan.` }
      : { ok: false, jobId, done: true, message: `Verifikasi gagal: ${result.failures.slice(0, 5).join(", ")}${result.failures.length > 5 ? ` (+${result.failures.length - 5})` : ""}.` };
  } catch (error) { return { ok: false, jobId, done: false, message: describeExportError(error) }; }
}
