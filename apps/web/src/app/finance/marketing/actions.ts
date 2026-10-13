"use server";

import { revalidatePath } from "next/cache";

import { describeSpendError, validateSpendForm } from "@/lib/marketing-spend";
import { loadBranchTimezones } from "@/lib/branch-context";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { zonedDayISO } from "@/lib/timezone";

export interface MarketingSpendActionState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENIED: MarketingSpendActionState = { error: "Anda tidak memiliki izin finance.manage untuk mengubah biaya pemasaran.", success: null };

function single(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

// Neither action sends an organization, user or branch: the database derives them from the authenticated session.

export async function recordMarketingSpendAction(_previous: MarketingSpendActionState, formData: FormData): Promise<MarketingSpendActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["finance.manage"]) return DENIED;
    const requestKey = single(formData, "requestKey");
    if (!UUID.test(requestKey)) return { error: "Permintaan tidak valid. Muat ulang halaman.", success: null };
    const { defaultTimezone } = await loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id);
    const input = { source: single(formData, "source"), amount: single(formData, "amount"), currency: single(formData, "currency"), spentOn: single(formData, "spentOn"), note: single(formData, "note") };
    const checked = validateSpendForm(input, zonedDayISO(new Date(), defaultTimezone));
    if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("record_marketing_spend", {
      p_source: checked.source, p_spent_on: input.spentOn, p_amount: checked.amount, p_currency: checked.currency, p_note: input.note.trim() || null, p_request_key: requestKey,
    });
    if (error) {
      console.error("marketing_spend_record_failed", { code: error.code });
      return { error: describeSpendError(error), success: null };
    }
    revalidatePath("/finance/marketing");
    revalidatePath("/dashboard");
    return { error: null, success: "Biaya dicatat. Catatan tidak dapat diubah; koreksi dengan pembalikan." };
  } catch (error) {
    console.error("marketing_spend_record_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Biaya belum tersimpan. Coba lagi.", success: null };
  }
}

export async function reverseMarketingSpendAction(_previous: MarketingSpendActionState, formData: FormData): Promise<MarketingSpendActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["finance.manage"]) return DENIED;
    const entryId = single(formData, "entryId");
    const requestKey = single(formData, "requestKey");
    const reason = single(formData, "reason").trim();
    if (!UUID.test(entryId) || !UUID.test(requestKey) || reason.length < 3 || reason.length > 200) return { error: "Alasan (3–200 karakter) wajib diisi.", success: null };
    const { error } = await workspace.supabase.schema("app").rpc("reverse_marketing_spend", { p_entry: entryId, p_reason: reason, p_request_key: requestKey });
    if (error) {
      console.error("marketing_spend_reverse_failed", { code: error.code });
      return { error: describeSpendError(error), success: null };
    }
    revalidatePath("/finance/marketing");
    revalidatePath("/dashboard");
    return { error: null, success: "Pembalikan dicatat; catatan asli tetap tersimpan." };
  } catch (error) {
    console.error("marketing_spend_reverse_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Pembalikan belum tersimpan. Coba lagi.", success: null };
  }
}
