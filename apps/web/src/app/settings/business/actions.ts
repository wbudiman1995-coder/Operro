"use server";

import { revalidatePath } from "next/cache";

import { describeSettingsError, parseTime, validateCalendarHours } from "@/lib/business-settings";
import { describeDefaultsError, validateDefaultsForm } from "@/lib/business-defaults";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface BusinessSettingsState { error: string | null; success: string | null }
export type BranchActionState = BusinessSettingsState;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function one(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

export async function setBranchCalendarHoursAction(_previous: BusinessSettingsState, formData: FormData): Promise<BusinessSettingsState> {
  try {
    const workspace = await requireActiveWorkspace();
    const branchId = one(formData, "branchId"); const token = one(formData, "updatedAt"); const reset = one(formData, "intent") === "reset";
    if (!UUID.test(branchId) || !TOKEN.test(token)) return { error: "Permintaan tidak valid. Muat ulang halaman.", success: null };
    const start = reset ? null : parseTime(one(formData, "open")); const end = reset ? null : parseTime(one(formData, "close"));
    if (!reset && (start === null || end === null)) return { error: "Pilih jam buka dan jam tutup.", success: null };
    const checked = validateCalendarHours(start, end); if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_branch_calendar_hours", { p_branch: branchId, p_start_minutes: start, p_end_minutes: end, p_expected_updated_at: token });
    if (error) return { error: describeSettingsError(error), success: null };
    revalidatePath("/settings/business"); revalidatePath("/schedule");
    return { error: null, success: reset ? "Jam kalender dikembalikan ke bawaan (08:30–18:00)." : "Jam kalender disimpan. Hanya mengubah rentang tampilan kalender." };
  } catch { return { error: "Perubahan belum tersimpan. Coba lagi.", success: null }; }
}

export async function saveBusinessDefaultsAction(_previous: BusinessSettingsState, formData: FormData): Promise<BusinessSettingsState> {
  try {
    const workspace = await requireActiveWorkspace();
    const checked = validateDefaultsForm({ labelsText: one(formData, "labels"), dueDays: one(formData, "dueDays"), version: one(formData, "version") });
    if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_business_defaults", { p_source_labels: checked.labels, p_invoice_due_days: checked.dueDays, p_expected_version: checked.version });
    if (error) return { error: describeDefaultsError(error), success: null };
    revalidatePath("/settings/business"); revalidatePath("/invoices/new"); revalidatePath("/customers");
    return { error: null, success: "Bawaan disimpan. Label hanya menjadi saran di formulir; jatuh tempo bawaan hanya mengisi invoice baru." };
  } catch { return { error: "Bawaan belum tersimpan. Coba lagi.", success: null }; }
}

export async function createBranchAction(_previous: BranchActionState, formData: FormData): Promise<BranchActionState> {
  const workspace = await requireActiveWorkspace();
  const name = String(formData.get("name") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "Asia/Jakarta").trim();
  if (name.length < 2 || name.length > 100 || timezone.length < 3 || timezone.length > 80) return { error: "Nama cabang atau zona waktu tidak valid.", success: null };
  const result = await workspace.supabase.schema("app").rpc("create_branch", { p_name: name, p_timezone: timezone });
  if (result.error) return { error: result.error.message.includes("invalid_branch") ? "Nama cabang atau zona waktu tidak valid." : result.error.message.includes("23505") ? "Nama cabang sudah digunakan." : "Cabang belum dapat dibuat. Pastikan Anda pemilik bisnis atau memiliki izin branches.manage.", success: null };
  revalidatePath("/settings/business"); revalidatePath("/catalog"); revalidatePath("/schedule"); revalidatePath("/bookings");
  return { error: null, success: `${name} siap dipakai untuk jadwal dan booking.` };
}
