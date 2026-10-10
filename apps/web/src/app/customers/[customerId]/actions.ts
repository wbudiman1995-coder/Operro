"use server";

import { revalidatePath } from "next/cache";
import { parseCustomerPetForm } from "@/lib/customer-pet-edit";
import { isCustomerId, parseCustomerProfileForm, parseExpectedUpdatedAt } from "@/lib/customer-profile-edit";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface CustomerProfileEditState {
  error: string | null;
  success: string | null;
}

export type CustomerPetEditState = CustomerProfileEditState;

function readSingleString(formData: FormData, key: string): string | null {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

export async function editCustomerProfileAction(
  _previous: CustomerProfileEditState,
  formData: FormData,
): Promise<CustomerProfileEditState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["customer.manage"]) return { error: "Anda tidak memiliki izin mengubah profil pelanggan.", success: null };

    const customerId = readSingleString(formData, "customerId");
    if (!isCustomerId(customerId)) return { error: "Data pelanggan tidak valid.", success: null };

    const expectedRaw = readSingleString(formData, "expectedUpdatedAt");
    if (expectedRaw === null) return { error: "Versi data pelanggan tidak valid.", success: null };
    const expected = parseExpectedUpdatedAt(expectedRaw);
    if (!expected.ok) return { error: expected.message, success: null };

    const parsed = parseCustomerProfileForm(formData);
    if (!parsed.ok) return { error: parsed.failures[0]?.message ?? "Data profil tidak valid.", success: null };

    const { data, error } = await workspace.supabase
      .from("customers")
      .update(parsed.update)
      .eq("organization_id", workspace.activeOrganization.id)
      .eq("id", customerId)
      .is("deleted_at", null)
      .eq("updated_at", expected.value)
      .select("id");

    if (error) {
      console.error("customer_profile_update_failed", error);
      return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
    }
    if (!data || data.length === 0) return { error: "Profil pelanggan sudah berubah. Muat ulang halaman lalu coba lagi.", success: null };

    revalidatePath("/customers");
    revalidatePath(`/customers/${customerId}`);
    return { error: null, success: "Profil pelanggan diperbarui." };
  } catch (error) {
    console.error("customer_profile_update_unexpected", error);
    return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
  }
}

export async function editCustomerPetAction(
  _previous: CustomerPetEditState,
  formData: FormData,
): Promise<CustomerPetEditState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["customer.manage"]) return { error: "Anda tidak memiliki izin mengubah data hewan.", success: null };

    const customerId = readSingleString(formData, "customerId");
    const petId = readSingleString(formData, "petId");
    if (!isCustomerId(customerId) || !isCustomerId(petId)) return { error: "Data hewan tidak valid.", success: null };

    const expectedRaw = readSingleString(formData, "expectedUpdatedAt");
    if (expectedRaw === null) return { error: "Versi data hewan tidak valid.", success: null };
    const expected = parseExpectedUpdatedAt(expectedRaw);
    if (!expected.ok) return { error: "Versi data hewan tidak valid.", success: null };

    const parsed = parseCustomerPetForm(formData);
    if (!parsed.ok) return { error: parsed.message, success: null };

    const { error } = await workspace.supabase.schema("app").rpc("update_customer_pet", {
      p_pet: petId,
      p_customer: customerId,
      p_expected_updated_at: expected.value,
      p_name: parsed.update.name,
      p_species: parsed.update.species,
      p_breed: parsed.update.breed,
      p_sex: parsed.update.sex,
      p_birthdate: parsed.update.birthdate,
      p_weight_kg: parsed.update.weightKg,
      p_manual_size: parsed.update.manualSize,
      p_color: parsed.update.color,
      p_temperament: parsed.update.temperament,
      p_notes: parsed.update.notes,
      p_coat_type: parsed.update.coatType,
      p_skin_history: parsed.update.skinHistory,
    });

    if (error) {
      console.error("customer_pet_update_failed", error);
      if (error.code === "40001") return { error: "Data hewan sudah berubah. Muat ulang halaman lalu coba lagi.", success: null };
      if (error.code === "42501") return { error: "Anda tidak memiliki izin mengubah data hewan.", success: null };
      if (error.code === "P0002") return { error: "Hewan tidak ditemukan pada pelanggan ini.", success: null };
      if (error.code === "22023") return { error: "Data hewan, jenis, atau ukuran tidak valid untuk bisnis ini.", success: null };
      return { error: "Perubahan hewan belum disimpan. Coba lagi.", success: null };
    }

    revalidatePath("/customers");
    revalidatePath(`/customers/${customerId}`);
    return { error: null, success: "Data hewan diperbarui." };
  } catch (error) {
    console.error("customer_pet_update_unexpected", error);
    return { error: "Perubahan hewan belum disimpan. Coba lagi.", success: null };
  }
}
