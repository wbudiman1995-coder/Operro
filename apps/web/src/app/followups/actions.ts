"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import type { PilotActionState } from "@/app/pilot-actions";
import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
import { findUnknownPlaceholders, KNOWN_FOLLOWUP_PLACEHOLDERS, KNOWN_RENEWAL_PLACEHOLDERS } from "@/lib/followup-messages";
import { createClient } from "@/lib/supabase/server";

async function workspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return null;
  return { supabase, organizationId: context.activeOrganization.id };
}

function databaseError(scope: string, message: string): PilotActionState {
  return { error: `${scope}: ${message}`, success: null };
}

const SETTINGS_ERROR_MESSAGES: Record<string, string> = {
  stale_settings_write: "pengaturan sudah diubah pihak lain -- muat ulang halaman lalu coba lagi",
  invalid_inactivity_threshold: "ambang tidak aktif harus berupa bilangan bulat 1-365",
  template_required: "kedua templat pesan wajib diisi",
  insufficient_privilege: "izin settings.manage diperlukan",
};

/** Section 35: guarded write to organizations.settings.followup_retention (see migration SECTION 3). */
export async function updateFollowupRetentionSettingsAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace();
  if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  if (!(await loadCapabilities(context.supabase))["settings.manage"]) return databaseError("Pengaturan", "izin settings.manage diperlukan");

  const expectedUpdatedAt = String(formData.get("expectedUpdatedAt") ?? "");
  const thresholdRaw = String(formData.get("inactivityThresholdDays") ?? "");
  const followupTemplate = String(formData.get("followupTemplate") ?? "").trim();
  const renewalTemplate = String(formData.get("renewalTemplate") ?? "").trim();

  if (!expectedUpdatedAt) return databaseError("Pengaturan", "data tidak valid, muat ulang halaman");
  if (!/^\d+$/.test(thresholdRaw)) return databaseError("Pengaturan", "ambang tidak aktif harus berupa bilangan bulat 1-365");
  const threshold = Number(thresholdRaw);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 365) {
    return databaseError("Pengaturan", "ambang tidak aktif harus berupa bilangan bulat 1-365");
  }
  if (!followupTemplate || !renewalTemplate) return databaseError("Pengaturan", "kedua templat pesan wajib diisi");

  const unknownFollowup = findUnknownPlaceholders(followupTemplate, KNOWN_FOLLOWUP_PLACEHOLDERS);
  if (unknownFollowup.length > 0) return databaseError("Templat follow-up", `placeholder tidak dikenal: ${unknownFollowup.join(", ")}`);
  const unknownRenewal = findUnknownPlaceholders(renewalTemplate, KNOWN_RENEWAL_PLACEHOLDERS);
  if (unknownRenewal.length > 0) return databaseError("Templat perpanjangan", `placeholder tidak dikenal: ${unknownRenewal.join(", ")}`);

  const result = await context.supabase.schema("app").rpc("update_followup_retention_settings", {
    p_expected_updated_at: expectedUpdatedAt,
    p_inactivity_threshold_days: threshold,
    p_followup_template: followupTemplate,
    p_renewal_template: renewalTemplate,
  });
  if (result.error) {
    const code = result.error.message.split(":")[0];
    return databaseError("Pengaturan gagal", SETTINGS_ERROR_MESSAGES[code] ?? result.error.message);
  }
  revalidatePath("/followups");
  return { error: null, success: "Pengaturan retensi berhasil disimpan." };
}
