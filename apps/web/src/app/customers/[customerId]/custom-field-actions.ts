"use server";

import { revalidatePath } from "next/cache";
import { isCustomerId } from "@/lib/customer-profile-edit";
import { loadCustomFieldDefinitions, parseCustomFieldValuesForm, type CustomFieldEntity } from "@/lib/custom-fields";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface CustomFieldValuesState { error: string | null; success: string | null }

export async function saveCustomFieldValuesAction(_previous: CustomFieldValuesState, formData: FormData): Promise<CustomFieldValuesState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["customer.manage"]) return { error: "Anda tidak memiliki izin mengubah isian tambahan.", success: null };
    const entities = formData.getAll("entityType");
    const entityIds = formData.getAll("entityId");
    const customerIds = formData.getAll("customerId");
    if (entities.length !== 1 || entityIds.length !== 1 || customerIds.length !== 1) return { error: "Data isian tidak valid.", success: null };
    const entity = entities[0] as CustomFieldEntity;
    if ((entity !== "customer" && entity !== "pet") || !isCustomerId(entityIds[0]) || !isCustomerId(customerIds[0])) return { error: "Data isian tidak valid.", success: null };

    const definitions = await loadCustomFieldDefinitions(workspace.supabase, workspace.activeOrganization.id, entity);
    const parsed = parseCustomFieldValuesForm(formData, definitions);
    if (!parsed.ok) return { error: parsed.message, success: null };
    if (Object.keys(parsed.values).length === 0) return { error: null, success: "Tidak ada perubahan." };

    const { data, error } = await workspace.supabase.schema("app").rpc("set_custom_field_values", {
      p_entity_type: entity,
      p_entity_id: entityIds[0],
      p_values: parsed.values,
    });
    if (error) {
      console.error("custom_field_values_save_failed", error);
      if (error.code === "42501") return { error: "Anda tidak memiliki izin mengubah isian tambahan.", success: null };
      if (error.code === "P0002") return { error: "Data pelanggan atau hewan tidak ditemukan.", success: null };
      if (error.code === "22023") return { error: "Isian tidak valid atau sudah diarsipkan. Muat ulang halaman lalu coba lagi.", success: null };
      return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
    }
    revalidatePath(`/customers/${customerIds[0]}`);
    return { error: null, success: data === 0 ? "Tidak ada perubahan." : "Isian tambahan disimpan." };
  } catch (error) {
    console.error("custom_field_values_save_unexpected", error);
    return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
  }
}
