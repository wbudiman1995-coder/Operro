"use server";

import { revalidatePath } from "next/cache";

import { describeProviderError, validateProviderForm } from "@/lib/whatsapp-provider-settings";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface ProviderActionState { error: string | null; success: string | null }

function single(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

// Saves non-secret identifiers, consent and the owner's requested enabled state. The platform safety gate still decides whether the
// requested enabled state can take effect; this action never sends a message or reads a credential.
export async function saveProviderSettingsAction(_previous: ProviderActionState, formData: FormData): Promise<ProviderActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const input = {
      provider: single(formData, "provider"), phoneNumberId: single(formData, "phoneNumberId"), businessAccountId: single(formData, "businessAccountId"),
      consentAttested: single(formData, "consentAttested") === "on", enabled: single(formData, "enabled") === "on", version: single(formData, "version"),
    };
    const checked = validateProviderForm(input);
    if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_whatsapp_provider_settings", {
      p_provider: input.provider, p_phone_number_id: input.phoneNumberId.trim() || null, p_business_account_id: input.businessAccountId.trim() || null,
      p_consent_attested: input.consentAttested, p_enabled: input.enabled, p_expected_version: checked.version,
    });
    if (error) {
      console.error("whatsapp_provider_save_failed", { code: error.code });
      return { error: describeProviderError(error), success: null };
    }
    revalidatePath("/settings/whatsapp-provider");
    return { error: null, success: input.enabled ? "Pengaturan aktif sebagai persiapan. Operro belum mengirim pesan apa pun." : "Pengaturan disimpan sebagai persiapan dan tetap nonaktif." };
  } catch (error) {
    console.error("whatsapp_provider_save_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Pengaturan belum tersimpan. Coba lagi.", success: null };
  }
}
