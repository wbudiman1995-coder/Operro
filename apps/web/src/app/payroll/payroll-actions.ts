"use server";

/**
 * Function index: payroll lifecycle (sections 32-33), all through the app.* RPCs in
 * 20261001110000_payroll_engine_s32_rpcs.sql -- no direct table writes for anything
 * that has a server-side invariant (draft-only edits, approve/pay/undo, retention,
 * publish/unpublish). Cycle settings and per-groomer settings are the two exceptions
 * (plain config, no financial-state invariant, gated by payroll.manage RLS directly).
 */
import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export interface PilotActionState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPONENT_KEYS = new Set(["basic", "weekly", "noLate", "noSick", "styling", "botak", "transport", "perDog", "daily"]);

function textValue(formData: FormData, key: string, max = 200) {
  return String(formData.get(key) ?? "").trim().slice(0, max);
}
function idValue(formData: FormData, key: string) {
  const value = textValue(formData, key, 36);
  return UUID.test(value) ? value : null;
}
function numberValue(formData: FormData, key: string) {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : null;
}

async function workspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context?.activeOrganization) return null;
  return { supabase, organizationId: context.activeOrganization.id };
}

function databaseError(scope: string, message: string) {
  return { error: `${scope}: ${message}`, success: null };
}
function ok(success: string) {
  return { error: null, success };
}

function friendlyRpcError(message: string) {
  if (/insufficient_privilege|missing_permission|wrong_organization|wrong_branch/.test(message)) return "izin tidak mencukupi untuk aksi ini";
  if (/run_not_editable/.test(message)) return "cycle ini sudah tidak berstatus draft";
  if (/run_not_approvable/.test(message)) return "cycle harus berstatus draft untuk disetujui";
  if (/run_not_payable/.test(message)) return "cycle harus disetujui dulu sebelum dibayar";
  if (/run_not_undoable/.test(message)) return "hanya cycle yang sudah dibayar yang bisa di-undo";
  if (/run_has_no_items/.test(message)) return "hitung payroll dulu sebelum menyetujui";
  if (/retention_not_yet_payable/.test(message)) return "belum memenuhi masa kerja minimum untuk deposit retensi";
  if (/retention_not_enabled_for_member/.test(message)) return "retensi belum diaktifkan untuk staf ini";
  if (/no_hire_date_on_record/.test(message)) return "tanggal bergabung staf ini belum tercatat";
  return message;
}

export async function recomputePayrollAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const periodStart = textValue(formData, "periodStart", 10); const periodEnd = textValue(formData, "periodEnd", 10);
  if (!periodStart || !periodEnd) return databaseError("Payroll", "periode tidak valid");
  const result = await context.supabase.schema("app").rpc("recompute_payroll_run", { p_period_start: periodStart, p_period_end: periodEnd, p_branch: null });
  if (result.error) return databaseError("Hitung payroll gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll");
  return ok("Payroll berhasil dihitung.");
}

export async function approvePayrollAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); if (!runId) return databaseError("Payroll", "cycle tidak valid");
  const result = await context.supabase.schema("app").rpc("approve_payroll_run", { p_run_id: runId });
  if (result.error) return databaseError("Setujui gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll");
  return ok("Payroll disetujui.");
}

export async function payPayrollAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); if (!runId) return databaseError("Payroll", "cycle tidak valid");
  const result = await context.supabase.schema("app").rpc("pay_payroll_run", { p_run_id: runId });
  if (result.error) return databaseError("Tandai lunas gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll"); revalidatePath("/my-schedule");
  return ok("Payroll ditandai lunas.");
}

export async function undoPayrollPaymentAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); const reason = textValue(formData, "reason", 500);
  if (!runId) return databaseError("Payroll", "cycle tidak valid");
  if (reason.length < 3) return databaseError("Undo pembayaran", "alasan koreksi wajib diisi");
  const result = await context.supabase.schema("app").rpc("undo_payroll_payment", { p_run_id: runId, p_reason: reason });
  if (result.error) return databaseError("Undo pembayaran gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll"); revalidatePath("/my-schedule");
  return ok("Pembayaran dibatalkan (dikoreksi); cycle kembali ke draft.");
}

export async function setPayrollOverrideAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); const membershipId = idValue(formData, "membershipId");
  const component = textValue(formData, "component", 20); const amount = numberValue(formData, "amount");
  const reason = textValue(formData, "reason", 300);
  if (!runId || !membershipId || !COMPONENT_KEYS.has(component)) return databaseError("Override", "data tidak valid");
  if (amount === null || amount < 0) return databaseError("Override", "nominal wajib diisi (boleh 0)");
  const result = await context.supabase.schema("app").rpc("set_payroll_item_override", { p_run_id: runId, p_membership: membershipId, p_component: component, p_amount: amount, p_reason: reason || null });
  if (result.error) return databaseError("Override gagal disimpan", friendlyRpcError(result.error.message));
  revalidatePath("/payroll");
  return ok("Override komponen tersimpan.");
}

export async function clearPayrollOverrideAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); const membershipId = idValue(formData, "membershipId");
  const component = textValue(formData, "component", 20);
  if (!runId || !membershipId || !COMPONENT_KEYS.has(component)) return databaseError("Override", "data tidak valid");
  const result = await context.supabase.schema("app").rpc("clear_payroll_item_override", { p_run_id: runId, p_membership: membershipId, p_component: component });
  if (result.error) return databaseError("Hapus override gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll");
  return ok("Override dihapus, kembali ke nilai hitung otomatis.");
}

export async function upsertPayrollCustomRowAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); const membershipId = idValue(formData, "membershipId");
  const rowId = idValue(formData, "rowId"); const label = textValue(formData, "label", 120); const amount = numberValue(formData, "amount");
  if (!runId || !membershipId) return databaseError("Tambahan pay", "data tidak valid");
  if (amount === null || amount < 0) return databaseError("Tambahan pay", "nominal wajib diisi (boleh 0)");
  if (amount > 0 && label.length === 0) return databaseError("Tambahan pay", "isi nama untuk baris yang memiliki nominal");
  const result = await context.supabase.schema("app").rpc("upsert_payroll_custom_row", { p_run_id: runId, p_row_id: rowId, p_membership: membershipId, p_label: label, p_amount: amount, p_sort_order: 0 });
  if (result.error) return databaseError("Tambahan pay gagal disimpan", friendlyRpcError(result.error.message));
  revalidatePath("/payroll");
  return ok("Baris tambahan pay tersimpan.");
}

export async function deletePayrollCustomRowAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); const rowId = idValue(formData, "rowId");
  if (!runId || !rowId) return databaseError("Tambahan pay", "data tidak valid");
  const result = await context.supabase.schema("app").rpc("delete_payroll_custom_row", { p_run_id: runId, p_row_id: rowId });
  if (result.error) return databaseError("Hapus baris gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll");
  return ok("Baris tambahan pay dihapus.");
}

export async function payRetentionDepositAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const membershipId = idValue(formData, "membershipId"); if (!membershipId) return databaseError("Retensi", "staf tidak valid");
  const result = await context.supabase.schema("app").rpc("pay_retention_deposit", { p_membership: membershipId });
  if (result.error) return databaseError("Bayar deposit retensi gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll");
  return ok("Deposit retensi dibayar.");
}

export async function publishPayrollSnapshotAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const runId = idValue(formData, "runId"); const membershipId = idValue(formData, "membershipId");
  if (!runId || !membershipId) return databaseError("Publish", "data tidak valid");
  const result = await context.supabase.schema("app").rpc("publish_payroll_snapshot", { p_run_id: runId, p_membership: membershipId });
  if (result.error) return databaseError("Publish gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll"); revalidatePath("/my-schedule");
  return ok("Gaji dipublikasikan ke halaman staf.");
}

export async function unpublishPayrollSnapshotAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const membershipId = idValue(formData, "membershipId"); if (!membershipId) return databaseError("Publish", "staf tidak valid");
  const result = await context.supabase.schema("app").rpc("unpublish_payroll_snapshot", { p_membership: membershipId });
  if (result.error) return databaseError("Sembunyikan gagal", friendlyRpcError(result.error.message));
  revalidatePath("/payroll"); revalidatePath("/my-schedule");
  return ok("Gaji disembunyikan dari halaman staf.");
}

export async function saveCycleSettingsAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const cycleStartDay = numberValue(formData, "cycleStartDay");
  if (cycleStartDay === null || cycleStartDay < 1 || cycleStartDay > 28) return databaseError("Pengaturan", "tanggal mulai cycle harus 1-28");
  const patch = {
    cycle_start_day: cycleStartDay,
    weekly_salary_amount_default: numberValue(formData, "weeklySalaryAmountDefault") ?? 0,
    no_late_amount_default: numberValue(formData, "noLateAmountDefault") ?? 0,
    no_sick_amount_default: numberValue(formData, "noSickAmountDefault") ?? 0,
    botak_amount_default: numberValue(formData, "botakAmountDefault") ?? 0,
    per_pet_amount_default: numberValue(formData, "perPetAmountDefault") ?? 0,
    daily_amount_default: numberValue(formData, "dailyAmountDefault") ?? 0,
    retention_amount_per_month_default: numberValue(formData, "retentionAmountPerMonthDefault") ?? 0,
    retention_term_months_default: numberValue(formData, "retentionTermMonthsDefault") ?? 24,
  };
  const result = await context.supabase.from("payroll_cycle_settings")
    .update(patch).eq("organization_id", context.organizationId);
  if (result.error) return databaseError("Pengaturan gagal disimpan", result.error.message);
  revalidatePath("/payroll");
  return ok("Pengaturan payroll tersimpan.");
}

export async function saveStaffSettingsAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await workspace(); if (!context) return databaseError("Sesi", "workspace aktif tidak tersedia");
  const membershipId = idValue(formData, "membershipId"); if (!membershipId) return databaseError("Pengaturan staf", "staf tidak valid");
  const patch = {
    organization_id: context.organizationId, membership_id: membershipId,
    weekly_salary_enabled: formData.get("weeklySalaryEnabled") === "on",
    no_late_enabled: formData.get("noLateEnabled") === "on",
    no_sick_enabled: formData.get("noSickEnabled") === "on",
    botak_enabled: formData.get("botakEnabled") === "on",
    per_pet_enabled: formData.get("perPetEnabled") === "on",
    styling_enabled: formData.get("stylingEnabled") === "on",
    daily_enabled: formData.get("dailyEnabled") === "on",
    retention_enabled: formData.get("retentionEnabled") === "on",
  };
  const result = await context.supabase.from("staff_payroll_settings")
    .upsert(patch, { onConflict: "organization_id,membership_id" });
  if (result.error) return databaseError("Pengaturan staf gagal disimpan", result.error.message);
  revalidatePath("/payroll");
  return ok("Pengaturan staf tersimpan.");
}
