"use server";

import { revalidatePath } from "next/cache";

import { describeMappingError, validateMappingForm } from "@/lib/cash-mapping";
import { loadBranchTimezones } from "@/lib/branch-context";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { zonedDayISO } from "@/lib/timezone";

export interface CashMappingActionState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function single(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

// Nothing here sends an organization, user or currency: the database derives them from the authenticated session and the account.
export async function setCashAccountMappingAction(_previous: CashMappingActionState, formData: FormData): Promise<CashMappingActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["finance.manage"]) return { error: "Anda tidak memiliki izin finance.manage untuk mengubah pemetaan kas.", success: null };
    const requestKey = single(formData, "requestKey");
    if (!UUID.test(requestKey)) return { error: "Permintaan tidak valid. Muat ulang halaman.", success: null };
    const { defaultTimezone } = await loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id);
    const input = { flow: single(formData, "flow"), method: single(formData, "method"), branchId: single(formData, "branchId"), accountId: single(formData, "accountId"), effectiveFrom: single(formData, "effectiveFrom") };
    const checked = validateMappingForm(input, zonedDayISO(new Date(), defaultTimezone));
    if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_cash_account_mapping", {
      p_flow: input.flow, p_method: input.method || null, p_branch: input.branchId || null, p_account: input.accountId || null,
      p_effective_from: input.effectiveFrom, p_request_key: requestKey,
    });
    if (error) {
      console.error("cash_mapping_set_failed", { code: error.code });
      return { error: describeMappingError(error), success: null };
    }
    revalidatePath("/finance/register");
    revalidatePath("/finance/register/mapping");
    return { error: null, success: input.accountId === "" ? "Pemetaan dihentikan mulai tanggal berlaku. Riwayat tetap tersimpan." : "Pemetaan dicatat. Pemetaan tidak dapat diubah; tambahkan pemetaan baru untuk menggantinya." };
  } catch (error) {
    console.error("cash_mapping_set_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Pemetaan belum tersimpan. Coba lagi.", success: null };
  }
}
