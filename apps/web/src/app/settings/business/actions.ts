"use server";

import { revalidatePath } from "next/cache";

import { describeSettingsError, parseTime, validateCalendarHours } from "@/lib/business-settings";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface BusinessSettingsState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function one(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

/**
 * Sets (or resets) one branch's calendar working hours. The browser supplies the branch it was shown, the two times and the
 * concurrency token it was shown; organization, user and authority come from the session inside the database.
 */
export async function setBranchCalendarHoursAction(_previous: BusinessSettingsState, formData: FormData): Promise<BusinessSettingsState> {
  try {
    const workspace = await requireActiveWorkspace();
    const branchId = one(formData, "branchId");
    const token = one(formData, "updatedAt");
    const reset = one(formData, "intent") === "reset";
    if (!UUID.test(branchId) || !TOKEN.test(token)) return { error: "Permintaan tidak valid. Muat ulang halaman.", success: null };
    const start = reset ? null : parseTime(one(formData, "open"));
    const end = reset ? null : parseTime(one(formData, "close"));
    if (!reset && (start === null || end === null)) return { error: "Pilih jam buka dan jam tutup.", success: null };
    const checked = validateCalendarHours(start, end);
    if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_branch_calendar_hours", { p_branch: branchId, p_start_minutes: start, p_end_minutes: end, p_expected_updated_at: token });
    if (error) {
      console.error("branch_calendar_hours_failed", { code: error.code });
      return { error: describeSettingsError(error), success: null };
    }
    revalidatePath("/settings/business"); revalidatePath("/schedule");
    return { error: null, success: reset ? "Jam kalender dikembalikan ke bawaan (08:30–18:00)." : "Jam kalender disimpan. Hanya mengubah rentang tampilan kalender." };
  } catch (error) {
    console.error("branch_calendar_hours_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Perubahan belum tersimpan. Coba lagi.", success: null };
  }
}
