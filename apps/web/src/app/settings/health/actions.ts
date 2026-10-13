"use server";

import { revalidatePath } from "next/cache";

import { loadBranchTimezones } from "@/lib/branch-context";
import { describeDrillError, validateDrillForm } from "@/lib/recovery-evidence";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { zonedDayISO } from "@/lib/timezone";

export interface DrillState { error: string | null; success: string | null }

function one(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

/**
 * Records one restore drill with its kind and, for archive drills, the manifest (and report) hash. Platform owner only (re-checked in the
 * database); append-only. The database alone decides whether the manifest hash matches a completed export; the browser sends only what
 * the person typed. Nothing here runs, simulates or verifies a restore.
 */
export async function recordRecoveryDrillAction(_previous: DrillState, formData: FormData): Promise<DrillState> {
  try {
    const workspace = await requireActiveWorkspace();
    const { defaultTimezone } = await loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id);
    const checked = validateDrillForm({
      date: one(formData, "drillDate"), outcome: one(formData, "outcome"), restoredTo: one(formData, "restoredTo"), kind: one(formData, "kind"),
      manifestSha: one(formData, "manifestSha"), reportSha: one(formData, "reportSha"), notes: one(formData, "notes"), evidenceRef: one(formData, "evidenceRef"),
      rpo: one(formData, "rpoMinutes"), rto: one(formData, "rtoMinutes"),
    }, zonedDayISO(new Date(), defaultTimezone));
    if (!checked.ok) return { error: checked.message, success: null };
    const { args } = checked;
    const { error } = await workspace.supabase.schema("app").rpc("record_recovery_drill_with_evidence", {
      p_drill_date: args.date, p_outcome: args.outcome, p_restored_to: args.restoredTo, p_rpo_minutes: args.rpo, p_rto_minutes: args.rto,
      p_notes: args.notes, p_evidence_ref: args.evidenceRef, p_kind: args.kind, p_manifest_sha: args.manifestSha, p_report_sha: args.reportSha,
    });
    if (error) {
      console.error("recovery_drill_failed", error.code);
      return { error: describeDrillError(error), success: null };
    }
    revalidatePath("/settings/health");
    return { error: null, success: "Uji pemulihan dicatat. Catatan ini tidak dapat diubah atau dihapus." };
  } catch (error) {
    console.error("recovery_drill_unexpected", error);
    return { error: "Uji pemulihan belum tersimpan. Coba lagi.", success: null };
  }
}
