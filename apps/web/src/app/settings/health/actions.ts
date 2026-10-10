"use server";

import { revalidatePath } from "next/cache";

import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface DrillState { error: string | null; success: string | null }

function one(formData: FormData, key: string): string | null {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}
function intOrNull(value: string | null): number | null | undefined {
  if (value === null || value.trim() === "") return null;
  return /^[0-9]{1,6}$/.test(value.trim()) ? Number(value.trim()) : undefined;
}

/** Records one restore drill. Platform owner only (re-checked in the database); append-only. */
export async function recordRecoveryDrillAction(_previous: DrillState, formData: FormData): Promise<DrillState> {
  try {
    const workspace = await requireActiveWorkspace();
    const date = one(formData, "drillDate");
    const outcome = one(formData, "outcome");
    const restoredTo = one(formData, "restoredTo");
    const rpo = intOrNull(one(formData, "rpoMinutes"));
    const rto = intOrNull(one(formData, "rtoMinutes"));
    const notes = one(formData, "notes") ?? "";
    const evidence = one(formData, "evidenceRef") ?? "";
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !outcome || !restoredTo || rpo === undefined || rto === undefined || notes.length > 500 || evidence.length > 300) {
      return { error: "Data uji pemulihan tidak valid.", success: null };
    }
    const { error } = await workspace.supabase.schema("app").rpc("record_recovery_drill", {
      p_drill_date: date, p_outcome: outcome, p_restored_to: restoredTo, p_rpo_minutes: rpo, p_rto_minutes: rto,
      p_notes: notes.trim() || null, p_evidence_ref: evidence.trim() || null,
    });
    if (error) {
      console.error("recovery_drill_failed", error.code);
      if (error.code === "42501") return { error: "Hanya pemilik platform Operro yang dapat mencatat uji pemulihan.", success: null };
      if (error.message?.includes("credential_like_text")) return { error: "Catatan atau referensi tampak memuat kredensial. Hapus kata sandi, token, atau connection string.", success: null };
      return { error: "Data uji pemulihan tidak valid.", success: null };
    }
    revalidatePath("/settings/health");
    return { error: null, success: "Uji pemulihan dicatat. Catatan ini tidak dapat diubah atau dihapus." };
  } catch (error) {
    console.error("recovery_drill_unexpected", error);
    return { error: "Uji pemulihan belum tersimpan. Coba lagi.", success: null };
  }
}
