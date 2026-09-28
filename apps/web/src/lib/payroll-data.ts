/**
 * Function index:
 * - loadPayrollWorkspace: loads one payroll cycle's full state (run, per-groomer breakdown,
 *   overrides, custom rows, missing-invoice queue, publications) plus the org/per-groomer
 *   settings needed to configure it. Sections 32-33.
 * - loadMyPayrollSnapshot: the groomer's own published snapshot (my-schedule page).
 *
 * All money/date decisions are computed server-side by the app.* RPCs in
 * 20261010110000_payroll_engine_s32_rpcs.sql -- this module only shapes the RPC/table
 * results for the UI; it does not itself decide a period boundary or compute a component.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

function assertResult(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`${scope}_failed:${error.message}`);
}

function relationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

function embeddedStaffName(value: unknown) {
  const user = relationRows(relationRows(value)[0]?.users)[0];
  const name = (user?.full_name as string | undefined) ?? (user?.email as string | undefined);
  return typeof name === "string" && name.length > 0 ? name : "Staf";
}

export interface PayrollBreakdown {
  basic: number; weekly: number; noLate: number; noSick: number; styling: number;
  botak: number; transport: number; perDog: number; daily: number;
  meta: {
    stylingCount: number; stylingRevenue: number; stylingAppliedPct: number; botakCount: number;
    basicCount: number; lateCount: number; sickDays: number; scheduledDays: number; workedDays: number;
    weeklyPaidDays: number; calculationVersion: number;
  };
}

export interface PayrollCustomRow { id: string; label: string; amount: number; sortOrder: number }
export interface PayrollOverride { componentKey: string; amount: number; reason: string | null }

export interface PayrollStaffCard {
  membershipId: string;
  name: string;
  breakdown: PayrollBreakdown | null; // null until the first recompute
  customRows: PayrollCustomRow[];
  overrides: PayrollOverride[];
  grossPay: number;
  hiredAt: string | null;
  retentionEnabled: boolean;
  retentionEligible: boolean;
  retentionAlreadyPaid: boolean;
  published: boolean;
  publishedRunId: string | null;
}

export interface PayrollCycleSettings {
  cycleStartDay: number;
  weeklySalaryAmountDefault: number;
  noLateAmountDefault: number;
  noSickAmountDefault: number;
  stylingTiersDefault: Array<{ min_jobs: number; pct: number }>;
  botakAmountDefault: number;
  perPetAmountDefault: number;
  perPetSizeMatrixDefault: Record<string, number>;
  dailyAmountDefault: number;
  retentionAmountPerMonthDefault: number;
  retentionTermMonthsDefault: number;
}

export interface PayrollMissingItem { groomingJobPetId: string; bookingId: string; membershipId: string; staffName: string; startsAt: string }

export interface PayrollWorkspace {
  periodStart: string;
  periodEnd: string;
  previousAnchor: string;
  nextAnchor: string;
  label: string;
  run: { id: string; status: string; totalGross: number; totalNet: number; revision: number; correctionCount: number } | null;
  staff: PayrollStaffCard[];
  settings: PayrollCycleSettings;
  missing: PayrollMissingItem[];
}

const DEFAULT_SETTINGS: PayrollCycleSettings = {
  cycleStartDay: 26, weeklySalaryAmountDefault: 0, noLateAmountDefault: 0, noSickAmountDefault: 0,
  stylingTiersDefault: [{ min_jobs: 1, pct: 10 }, { min_jobs: 17, pct: 20 }],
  botakAmountDefault: 10000, perPetAmountDefault: 20000, perPetSizeMatrixDefault: {},
  dailyAmountDefault: 0, retentionAmountPerMonthDefault: 0, retentionTermMonthsDefault: 24,
};

function tenureMonths(hiredAt: string | null): number | null {
  if (!hiredAt) return null;
  const hired = new Date(hiredAt); const now = new Date();
  let months = (now.getFullYear() - hired.getFullYear()) * 12 + (now.getMonth() - hired.getMonth());
  if (now.getDate() < hired.getDate()) months -= 1;
  return Math.max(0, months);
}

export async function loadPayrollWorkspace(
  supabase: SupabaseClient, organizationId: string, anchor: string | null,
): Promise<PayrollWorkspace> {
  const bounds = await supabase.schema("app").rpc("payroll_cycle_bounds", { p_org: organizationId, p_anchor: anchor });
  assertResult("payroll_cycle_bounds", bounds.error);
  const row = (Array.isArray(bounds.data) ? bounds.data[0] : bounds.data) as { period_start: string; period_end: string } | null;
  if (!row) throw new Error("payroll_cycle_bounds_empty");
  const periodStart = row.period_start; const periodEnd = row.period_end;

  const [settingsResult, staffResult, runResult, resourcesResult] = await Promise.all([
    supabase.from("payroll_cycle_settings").select("*").eq("organization_id", organizationId).maybeSingle(),
    supabase.from("staff_compensation").select("membership_id,memberships(users(email,full_name))").eq("organization_id", organizationId).eq("is_active", true).is("deleted_at", null),
    supabase.from("payroll_runs").select("id,status,total_gross,total_net,revision,metadata").eq("organization_id", organizationId).is("branch_id", null).eq("period_start", periodStart).eq("period_end", periodEnd).maybeSingle(),
    supabase.from("resources").select("membership_id,hired_at").eq("organization_id", organizationId).eq("kind", "staff").is("deleted_at", null).not("membership_id", "is", null),
  ]);
  assertResult("payroll_settings", settingsResult.error); assertResult("payroll_staff", staffResult.error);
  assertResult("payroll_run", runResult.error); assertResult("payroll_resources", resourcesResult.error);

  const hiredAtByMembership = new Map<string, string | null>();
  for (const r of resourcesResult.data ?? []) hiredAtByMembership.set(r.membership_id as string, (r.hired_at as string | null) ?? null);

  const settingsRow = settingsResult.data;
  const settings: PayrollCycleSettings = settingsRow ? {
    cycleStartDay: settingsRow.cycle_start_day, weeklySalaryAmountDefault: Number(settingsRow.weekly_salary_amount_default),
    noLateAmountDefault: Number(settingsRow.no_late_amount_default), noSickAmountDefault: Number(settingsRow.no_sick_amount_default),
    stylingTiersDefault: settingsRow.styling_tiers_default ?? DEFAULT_SETTINGS.stylingTiersDefault,
    botakAmountDefault: Number(settingsRow.botak_amount_default), perPetAmountDefault: Number(settingsRow.per_pet_amount_default),
    perPetSizeMatrixDefault: settingsRow.per_pet_size_matrix_default ?? {}, dailyAmountDefault: Number(settingsRow.daily_amount_default),
    retentionAmountPerMonthDefault: Number(settingsRow.retention_amount_per_month_default), retentionTermMonthsDefault: settingsRow.retention_term_months_default,
  } : DEFAULT_SETTINGS;

  const runId = runResult.data?.id ?? null;
  const [itemsResult, overridesResult, customRowsResult, staffSettingsResult, publicationsResult, retentionPaidResult] = await Promise.all([
    runId ? supabase.from("payroll_items").select("membership_id,gross_pay,breakdown").eq("organization_id", organizationId).eq("payroll_run_id", runId) : Promise.resolve({ data: [], error: null }),
    runId ? supabase.from("payroll_item_overrides").select("membership_id,component_key,amount,reason").eq("organization_id", organizationId).eq("payroll_run_id", runId) : Promise.resolve({ data: [], error: null }),
    runId ? supabase.from("payroll_custom_rows").select("id,membership_id,label,amount,sort_order").eq("organization_id", organizationId).eq("payroll_run_id", runId).is("deleted_at", null) : Promise.resolve({ data: [], error: null }),
    supabase.from("staff_payroll_settings").select("*").eq("organization_id", organizationId),
    supabase.from("payroll_publications").select("membership_id,payroll_run_id,enabled").eq("organization_id", organizationId),
    supabase.from("payroll_retention_events").select("membership_id").eq("organization_id", organizationId).eq("kind", "payout"),
  ]);
  assertResult("payroll_items", itemsResult.error); assertResult("payroll_overrides", overridesResult.error);
  assertResult("payroll_custom_rows", customRowsResult.error); assertResult("staff_payroll_settings", staffSettingsResult.error);
  assertResult("payroll_publications", publicationsResult.error); assertResult("payroll_retention_paid", retentionPaidResult.error);

  const itemByMembership = new Map((itemsResult.data ?? []).map((r) => [r.membership_id as string, r]));
  const overridesByMembership = new Map<string, PayrollOverride[]>();
  for (const o of overridesResult.data ?? []) {
    const list = overridesByMembership.get(o.membership_id as string) ?? [];
    list.push({ componentKey: o.component_key as string, amount: Number(o.amount), reason: (o.reason as string | null) ?? null });
    overridesByMembership.set(o.membership_id as string, list);
  }
  const customRowsByMembership = new Map<string, PayrollCustomRow[]>();
  for (const c of customRowsResult.data ?? []) {
    const list = customRowsByMembership.get(c.membership_id as string) ?? [];
    list.push({ id: c.id as string, label: c.label as string, amount: Number(c.amount), sortOrder: c.sort_order as number });
    customRowsByMembership.set(c.membership_id as string, list);
  }
  const staffSettingsByMembership = new Map((staffSettingsResult.data ?? []).map((r) => [r.membership_id as string, r]));
  const publicationByMembership = new Map((publicationsResult.data ?? []).map((r) => [r.membership_id as string, r]));
  const retentionPaidSet = new Set((retentionPaidResult.data ?? []).map((r) => r.membership_id as string));

  const staff: PayrollStaffCard[] = (staffResult.data ?? []).map((row) => {
    const membershipId = row.membership_id as string;
    const item = itemByMembership.get(membershipId);
    const hiredAt = hiredAtByMembership.get(membershipId) ?? null;
    const staffSettingsRow = staffSettingsByMembership.get(membershipId);
    const retentionEnabled = Boolean(staffSettingsRow?.retention_enabled);
    const termMonths = staffSettingsRow?.retention_term_months ?? settings.retentionTermMonthsDefault;
    const tenure = tenureMonths(hiredAt);
    const publication = publicationByMembership.get(membershipId);
    return {
      membershipId, name: embeddedStaffName(row.memberships),
      breakdown: item ? (item.breakdown as PayrollBreakdown) : null,
      customRows: (customRowsByMembership.get(membershipId) ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
      overrides: overridesByMembership.get(membershipId) ?? [],
      grossPay: item ? Number(item.gross_pay) : 0,
      hiredAt, retentionEnabled,
      retentionEligible: retentionEnabled && tenure !== null && tenure >= termMonths,
      retentionAlreadyPaid: retentionPaidSet.has(membershipId),
      published: Boolean(publication?.enabled),
      publishedRunId: (publication?.payroll_run_id as string | undefined) ?? null,
    };
  });

  const missingResult = await supabase.schema("app").rpc("payroll_missing_invoice_pets", { p_org: organizationId, p_period_start: periodStart, p_period_end: periodEnd });
  assertResult("payroll_missing", missingResult.error);
  const staffNameByMembership = new Map(staff.map((s) => [s.membershipId, s.name]));
  const missing: PayrollMissingItem[] = ((missingResult.data ?? []) as Array<{ grooming_job_pet_id: string; booking_id: string; membership_id: string; starts_at: string }>).map((m) => ({
    groomingJobPetId: m.grooming_job_pet_id, bookingId: m.booking_id, membershipId: m.membership_id,
    staffName: staffNameByMembership.get(m.membership_id) ?? "Staf", startsAt: m.starts_at,
  }));

  const start = new Date(`${periodStart}T00:00:00`); const end = new Date(`${periodEnd}T00:00:00`);
  const previousAnchor = new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10);
  const nextAnchor = periodEnd;
  const fmt = (d: Date) => d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
  const labelEnd = new Date(end.getTime() - 86_400_000);

  return {
    periodStart, periodEnd, previousAnchor, nextAnchor, label: `${fmt(start)} — ${fmt(labelEnd)}`,
    run: runResult.data ? {
      id: runResult.data.id, status: runResult.data.status, totalGross: Number(runResult.data.total_gross),
      totalNet: Number(runResult.data.total_net), revision: runResult.data.revision,
      correctionCount: Number((runResult.data.metadata as Record<string, unknown> | null)?.correction_count ?? 0),
    } : null,
    staff, settings, missing,
  };
}

export interface PayrollExportDetailRow {
  bookingId: string; membershipId: string; staffName: string; startsAt: string;
  customerName: string; petName: string; petSize: string | null; services: string;
  serviceRevenue: number; invoiceNumber: string | null; invoiceStatus: string | null;
}

export async function loadPayrollExportDetail(
  supabase: SupabaseClient, organizationId: string, periodStart: string, periodEnd: string, staffByMembership: Map<string, string>,
): Promise<PayrollExportDetailRow[]> {
  const result = await supabase.schema("app").rpc("payroll_export_detail_rows", { p_org: organizationId, p_period_start: periodStart, p_period_end: periodEnd });
  assertResult("payroll_export_detail", result.error);
  type Row = { booking_id: string; membership_id: string; starts_at: string; customer_name: string; pet_name: string; pet_size: string | null; services: string; service_revenue: number; invoice_number: string | null; invoice_id: string | null; invoice_status: string | null };
  return ((result.data ?? []) as Row[]).map((r) => ({
    bookingId: r.booking_id, membershipId: r.membership_id, staffName: staffByMembership.get(r.membership_id) ?? "Staf",
    startsAt: r.starts_at, customerName: r.customer_name, petName: r.pet_name, petSize: r.pet_size,
    services: r.services, serviceRevenue: Number(r.service_revenue), invoiceNumber: r.invoice_number, invoiceStatus: r.invoice_status,
  }));
}

export interface MyPayrollSnapshot {
  staffName: string; status: string; periodStart: string; periodEnd: string; publishedAt: string; total: number;
  breakdown: PayrollBreakdown; customRows: Array<{ label: string; amount: number }>;
}

export async function loadMyPayrollSnapshot(supabase: SupabaseClient): Promise<MyPayrollSnapshot | null> {
  const result = await supabase.schema("app").rpc("get_my_payroll_snapshot");
  assertResult("my_payroll_snapshot", result.error);
  if (!result.data) return null;
  const d = result.data as Record<string, unknown>;
  return {
    staffName: (d.staffName as string) ?? "Staf",
    status: d.status as string, periodStart: d.periodStart as string, periodEnd: d.periodEnd as string,
    publishedAt: d.publishedAt as string, total: Number(d.total), breakdown: d.breakdown as PayrollBreakdown,
    customRows: (d.customRows as Array<{ label: string; amount: number }>) ?? [],
  };
}
