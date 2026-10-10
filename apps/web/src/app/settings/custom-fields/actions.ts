"use server";

import { revalidatePath } from "next/cache";
import { isCustomFieldId, parseCustomFieldDefinitionForm } from "@/lib/custom-fields";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface CustomFieldDefinitionState { error: string | null; success: string | null }

function describe(code: string | undefined, message: string | undefined): string {
  if (code === "42501") return "Hanya pengelola pengaturan yang dapat mengatur isian tambahan.";
  if (code === "40001") return "Isian sudah berubah. Muat ulang halaman lalu coba lagi.";
  if (code === "P0002") return "Isian tidak ditemukan.";
  if (code === "22023") {
    if (message?.includes("duplicate_custom_field_label")) return "Nama isian sudah dipakai untuk lingkup ini.";
    if (message?.includes("too_many_custom_fields")) return "Maksimal 20 isian aktif per lingkup. Arsipkan isian lama terlebih dahulu.";
    if (message?.includes("definition_archived")) return "Isian terarsip. Aktifkan kembali sebelum mengubahnya.";
    return "Data isian tidak valid.";
  }
  return "Perubahan belum disimpan. Coba lagi.";
}

export async function saveCustomFieldDefinitionAction(_previous: CustomFieldDefinitionState, formData: FormData): Promise<CustomFieldDefinitionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["settings.manage"]) return { error: "Anda tidak memiliki izin mengatur isian tambahan.", success: null };
    const parsed = parseCustomFieldDefinitionForm(formData);
    if (!parsed.ok) return { error: parsed.message, success: null };
    const { input } = parsed;
    const { error } = await workspace.supabase.schema("app").rpc("save_custom_field_definition", {
      p_id: input.id,
      p_entity_type: input.entityType,
      p_label: input.label,
      p_field_type: input.fieldType,
      p_option_labels: input.optionLabels,
      p_sort_order: input.sortOrder,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      console.error("custom_field_definition_save_failed", error);
      return { error: describe(error.code, error.message), success: null };
    }
    revalidatePath("/settings/custom-fields");
    revalidatePath("/customers", "layout");
    return { error: null, success: input.id ? "Isian diperbarui." : "Isian ditambahkan." };
  } catch (error) {
    console.error("custom_field_definition_save_unexpected", error);
    return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
  }
}

export async function setCustomFieldArchivedAction(_previous: CustomFieldDefinitionState, formData: FormData): Promise<CustomFieldDefinitionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["settings.manage"]) return { error: "Anda tidak memiliki izin mengatur isian tambahan.", success: null };
    const ids = formData.getAll("id");
    const modes = formData.getAll("archived");
    if (ids.length !== 1 || modes.length !== 1 || !isCustomFieldId(ids[0]) || (modes[0] !== "true" && modes[0] !== "false")) return { error: "Isian tidak valid.", success: null };
    const archived = modes[0] === "true";
    const { error } = await workspace.supabase.schema("app").rpc("set_custom_field_archived", { p_id: ids[0], p_archived: archived });
    if (error) {
      console.error("custom_field_archive_failed", error);
      return { error: describe(error.code, error.message), success: null };
    }
    revalidatePath("/settings/custom-fields");
    revalidatePath("/customers", "layout");
    return { error: null, success: archived ? "Isian diarsipkan. Nilai tersimpan tidak dihapus." : "Isian diaktifkan kembali." };
  } catch (error) {
    console.error("custom_field_archive_unexpected", error);
    return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
  }
}
