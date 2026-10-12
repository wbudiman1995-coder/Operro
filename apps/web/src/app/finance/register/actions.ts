"use server";

import { revalidatePath } from "next/cache";

import { ACCOUNT_KINDS, describeCashError, validateMovementForm } from "@/lib/cash-register";
import { zonedDayISO } from "@/lib/timezone";
import { loadBranchTimezones } from "@/lib/branch-context";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface CashRegisterActionState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENIED: CashRegisterActionState = { error: "Anda tidak memiliki izin finance.manage untuk mengubah register kas.", success: null };

function single(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}

// None of these actions sends an organization, branch, currency, direction or user: the database derives them from the
// authenticated session and the account row. The browser supplies only display inputs and the ids it was shown.

export async function createCashAccountAction(_previous: CashRegisterActionState, formData: FormData): Promise<CashRegisterActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["finance.manage"]) return DENIED;
    const name = single(formData, "name").trim();
    const kind = single(formData, "kind");
    const currency = single(formData, "currency").trim().toUpperCase();
    const branch = single(formData, "branchId");
    if (name.length < 1 || name.length > 80 || !(ACCOUNT_KINDS as readonly string[]).includes(kind) || !/^[A-Z]{3}$/.test(currency) || (branch !== "" && !UUID.test(branch))) {
      return { error: "Nama (1–80 karakter), jenis, dan mata uang tiga huruf wajib valid.", success: null };
    }
    const { error } = await workspace.supabase.schema("app").rpc("create_cash_account", { p_name: name, p_kind: kind, p_currency: currency, p_branch: branch === "" ? null : branch });
    if (error) {
      console.error("cash_account_create_failed", { code: error.code });
      return { error: describeCashError(error), success: null };
    }
    revalidatePath("/finance/register");
    return { error: null, success: "Akun kas dibuat. Mata uang dan cabang tidak dapat diubah setelah dibuat." };
  } catch (error) {
    console.error("cash_account_create_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Akun belum dapat dibuat. Coba lagi.", success: null };
  }
}

export async function recordCashMovementAction(_previous: CashRegisterActionState, formData: FormData): Promise<CashRegisterActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["finance.manage"]) return DENIED;
    const accountId = single(formData, "accountId");
    const requestKey = single(formData, "requestKey");
    if (!UUID.test(accountId) || !UUID.test(requestKey)) return { error: "Permintaan tidak valid. Muat ulang halaman.", success: null };
    const { defaultTimezone } = await loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id);
    const input = {
      kind: single(formData, "kind"), amount: single(formData, "amount"), occurredOn: single(formData, "occurredOn"),
      counterparty: single(formData, "counterparty"), memo: single(formData, "memo"), sourceType: single(formData, "sourceType"), sourceId: single(formData, "sourceId"),
    };
    const checked = validateMovementForm(input, zonedDayISO(new Date(), defaultTimezone));
    if (!checked.ok) return { error: checked.message, success: null };
    const { error } = await workspace.supabase.schema("app").rpc("record_cash_movement", {
      p_account: accountId, p_kind: input.kind, p_amount: checked.amount, p_occurred_on: input.occurredOn,
      p_counterparty: input.counterparty.trim() || null, p_memo: input.memo.trim() || null,
      p_source_type: input.sourceType || null, p_source_id: input.sourceId.trim() || null, p_request_key: requestKey,
    });
    if (error) {
      console.error("cash_movement_record_failed", { code: error.code });
      return { error: describeCashError(error), success: null };
    }
    revalidatePath("/finance/register");
    return { error: null, success: "Mutasi dicatat. Mutasi tidak dapat diubah; koreksi dengan pembalikan." };
  } catch (error) {
    console.error("cash_movement_record_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Mutasi belum tersimpan. Coba lagi.", success: null };
  }
}

export async function reverseCashMovementAction(_previous: CashRegisterActionState, formData: FormData): Promise<CashRegisterActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["finance.manage"]) return DENIED;
    const movementId = single(formData, "movementId");
    const requestKey = single(formData, "requestKey");
    const reason = single(formData, "reason").trim();
    const occurredOn = single(formData, "occurredOn");
    if (!UUID.test(movementId) || !UUID.test(requestKey) || reason.length < 3 || reason.length > 300 || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
      return { error: "Alasan (3–300 karakter) dan tanggal wajib diisi.", success: null };
    }
    const { error } = await workspace.supabase.schema("app").rpc("reverse_cash_movement", { p_movement: movementId, p_reason: reason, p_occurred_on: occurredOn, p_request_key: requestKey });
    if (error) {
      console.error("cash_movement_reverse_failed", { code: error.code });
      return { error: describeCashError(error), success: null };
    }
    revalidatePath("/finance/register");
    return { error: null, success: "Pembalikan dicatat sebagai mutasi baru; mutasi asli tetap tersimpan." };
  } catch (error) {
    console.error("cash_movement_reverse_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Pembalikan belum tersimpan. Coba lagi.", success: null };
  }
}

export async function setCashAccountArchivedAction(_previous: CashRegisterActionState, formData: FormData): Promise<CashRegisterActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    if (!workspace.capabilities["finance.manage"]) return DENIED;
    const accountId = single(formData, "accountId");
    const archived = single(formData, "archived");
    const version = Number(single(formData, "version"));
    if (!UUID.test(accountId) || (archived !== "true" && archived !== "false") || !Number.isInteger(version) || version < 1) return { error: "Permintaan tidak valid.", success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_cash_account_archived", { p_account: accountId, p_archived: archived === "true", p_expected_version: version });
    if (error) {
      console.error("cash_account_archive_failed", { code: error.code });
      return { error: describeCashError(error), success: null };
    }
    revalidatePath("/finance/register");
    return { error: null, success: archived === "true" ? "Akun diarsipkan." : "Akun diaktifkan kembali." };
  } catch (error) {
    console.error("cash_account_archive_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Perubahan belum tersimpan. Coba lagi.", success: null };
  }
}
