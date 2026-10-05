"use server";

import { revalidatePath } from "next/cache";

import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface BulkUpdateCustomersState {
  error: string | null;
  success: string | null;
  updated?: number;
  skipped?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RAW_IDS_LENGTH = 8192;
const MAX_CUSTOMERS = 100;
const CUSTOMER_STATUSES = ["lead", "active", "inactive", "archived"] as const;
type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

function isCustomerStatus(value: string): value is CustomerStatus {
  return (CUSTOMER_STATUSES as readonly string[]).includes(value);
}

export async function bulkUpdateCustomersAction(
  _previous: BulkUpdateCustomersState,
  formData: FormData,
): Promise<BulkUpdateCustomersState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["customer.manage"]) {
      return { error: "Anda tidak memiliki izin mengelola pelanggan.", success: null };
    }

    const rawIds = formData.get("customerIds");
    if (typeof rawIds !== "string" || rawIds.trim() === "") {
      return { error: "Pilih pelanggan terlebih dahulu.", success: null };
    }
    if (rawIds.length > MAX_RAW_IDS_LENGTH) {
      return { error: "Data pilihan terlalu besar.", success: null };
    }

    let parsedIds: unknown;
    try {
      parsedIds = JSON.parse(rawIds);
    } catch {
      return { error: "Data pilihan tidak valid.", success: null };
    }
    if (!Array.isArray(parsedIds) || parsedIds.length === 0) {
      return { error: "Pilih pelanggan terlebih dahulu.", success: null };
    }
    if (parsedIds.length > MAX_CUSTOMERS) {
      return { error: "Maksimal 100 pelanggan per permintaan.", success: null };
    }

    const validatedIds: string[] = [];
    for (const value of parsedIds) {
      if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        return { error: "Data pilihan tidak valid.", success: null };
      }
      validatedIds.push(value);
    }
    const uniqueIds = [...new Set(validatedIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_CUSTOMERS) {
      return { error: "Pilih 1–100 pelanggan yang valid.", success: null };
    }

    const statusValue = String(formData.get("status") ?? "");
    if (statusValue !== "" && !isCustomerStatus(statusValue)) {
      return { error: "Status pelanggan tidak valid.", success: null };
    }
    const sourceMode = String(formData.get("sourceMode") ?? "unchanged");
    if (sourceMode !== "unchanged" && sourceMode !== "set" && sourceMode !== "clear") {
      return { error: "Perubahan sumber tidak valid.", success: null };
    }

    const payload: { status?: CustomerStatus; source?: string | null } = {};
    if (statusValue !== "") payload.status = statusValue;
    if (sourceMode === "set") {
      const source = String(formData.get("source") ?? "").trim();
      if (source.length === 0 || source.length > 80) {
        return { error: "Sumber harus 1–80 karakter.", success: null };
      }
      payload.source = source;
    } else if (sourceMode === "clear") {
      payload.source = null;
    }
    if (Object.keys(payload).length === 0) {
      return { error: "Pilih setidaknya satu perubahan.", success: null };
    }

    const { data, error } = await workspace.supabase
      .from("customers")
      .update(payload)
      .eq("organization_id", workspace.activeOrganization.id)
      .in("id", uniqueIds)
      .is("deleted_at", null)
      .select("id");
    if (error) {
      console.error("bulk_update_customers_failed", error);
      return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
    }

    const updated = data?.length ?? 0;
    const skipped = uniqueIds.length - updated;
    if (updated === 0) {
      return { error: "Tidak ada pelanggan yang diperbarui. Data mungkin sudah berubah.", success: null, updated, skipped };
    }

    revalidatePath("/customers");
    return {
      error: null,
      success: skipped > 0 ? `${updated} pelanggan diperbarui, ${skipped} dilewati.` : `${updated} pelanggan diperbarui.`,
      updated,
      skipped,
    };
  } catch (error) {
    console.error("bulk_update_customers_unexpected", error);
    return { error: "Perubahan belum disimpan. Coba lagi.", success: null };
  }
}
