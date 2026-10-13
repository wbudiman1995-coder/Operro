"use server";

import { revalidatePath } from "next/cache";

import { describeProviderError, validateProviderForm } from "@/lib/whatsapp-provider-settings";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface ProviderActionState { error: string | null; success: string | null }

function single(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

// Saves identifiers and the consent attestation only. This action can never enable a provider (it always sends enabled = false), and the
// database would refuse enabling anyway while the platform has not opened the provider. The organization comes from the session.
export async function saveProviderSettingsAction(_previous: ProviderActionState, formData: FormData): Promise<ProviderActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const input = {
      provider: single(formData, "provider"), phoneNumberId: single(formData, "phoneNumberId"), businessAccountId: single(formData, "businessAccountId"),
      consentAttested: single(formData, "consentAttested") === "on", version: single(formData, "version"),
    };
    const checked = validateProviderForm(input);
    if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_whatsapp_provider_settings", {
      p_provider: input.provider, p_phone_number_id: input.phoneNumberId.trim() || null, p_business_account_id: input.businessAccountId.trim() || null,
      p_consent_attested: input.consentAttested, p_enabled: false, p_expected_version: checked.version,
    });
    if (error) {
      console.error("whatsapp_provider_save_failed", { code: error.code });
      return { error: describeProviderError(error), success: null };
    }
    revalidatePath("/settings/whatsapp-provider");
    return { error: null, success: "Pengaturan disimpan. Penyedia tetap nonaktif: Operro belum mengirim pesan apa pun." };
  } catch (error) {
    console.error("whatsapp_provider_save_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Pengaturan belum tersimpan. Coba lagi.", success: null };
  }
}
