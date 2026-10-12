"use server";

import { revalidatePath } from "next/cache";

import { SCHEDULE_CADENCES } from "@/lib/cleanup-schedule";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface ScheduleActionState { error: string | null; success: string | null }

/** Records or withdraws the owner's consent. It never runs a cleanup; the organization comes from the session. */
export async function setCleanupScheduleAction(_previous: ScheduleActionState, formData: FormData): Promise<ScheduleActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const enabledValues = formData.getAll("enabled");
    const cadenceValues = formData.getAll("cadence");
    const enabled = enabledValues.length === 1 ? enabledValues[0] : null;
    const cadence = cadenceValues.length === 1 && typeof cadenceValues[0] === "string" ? cadenceValues[0] : "weekly";
    if ((enabled !== "true" && enabled !== "false") || !(SCHEDULE_CADENCES as readonly string[]).includes(cadence)) return { error: "Pilihan tidak valid.", success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_storage_cleanup_schedule", { p_enabled: enabled === "true", p_cadence: cadence });
    if (error) {
      console.error("cleanup_schedule_set_failed", { code: error.code });
      return { error: error.code === "42501" ? "Hanya pemilik bisnis yang dapat mengubah persetujuan ini." : "Perubahan belum tersimpan. Coba lagi.", success: null };
    }
    revalidatePath("/settings/storage"); revalidatePath("/settings/health");
    return { error: null, success: enabled === "true" ? "Persetujuan dicatat. Belum ada penjadwal, sehingga tidak ada yang dihapus otomatis." : "Pembersihan otomatis dimatikan." };
  } catch (error) {
    console.error("cleanup_schedule_set_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Perubahan belum tersimpan. Coba lagi.", success: null };
  }
}
