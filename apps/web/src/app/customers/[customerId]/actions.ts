"use server";

import { revalidatePath } from "next/cache";
import { isCustomerId, parseCustomerProfileForm, parseExpectedUpdatedAt } from "@/lib/customer-profile-edit";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface CustomerProfileEditState {
  error: string | null;
  success: string | null;
}

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
