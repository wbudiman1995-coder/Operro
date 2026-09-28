import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Function index:
 * - loadFollowupRetentionSettings / updateFollowupRetentionSettings*: the
 *   org-level inactivity threshold + message templates (organizations.settings.followup_retention).
 * - loadOverdueQueue: paginated, customer-grouped overdue-pet queue (app.list_overdue_customers).
 * - loadRenewalQueue: paginated, customer-grouped recurring-membership queue (app.list_renewal_queue).
 *
 * All three call SECURITY DEFINER RPCs that perform their own tenant/branch/permission
 * authorization -- this module does no additional gating itself, matching the pattern
 * already used by previewPackageRenewalAction/renewCustomerPackageAction.
 */

export interface FollowupRetentionSettings {
  inactivityThresholdDays: number;
  followupTemplate: string;
  renewalTemplate: string;
  updatedAt: string;
}

export async function loadFollowupRetentionSettings(supabase: SupabaseClient): Promise<FollowupRetentionSettings> {
  const result = await supabase.schema("app").rpc("get_followup_retention_settings");
  if (result.error) throw new Error(`followup_settings_failed:${result.error.message}`);
  const data = result.data as Record<string, unknown>;
  return {
    inactivityThresholdDays: Number(data.inactivity_threshold_days),
    followupTemplate: String(data.followup_template),
    renewalTemplate: String(data.renewal_template),
    updatedAt: String(data.updated_at),
  };
}

export interface OverduePet {
  petId: string; petName: string; lastGroomedAt: string | null; daysSince: number | null;
  hasUpcomingBooking: boolean; anomalyFutureDated: boolean;
}
export interface OverdueCustomerGroup {
  customerId: string; customerName: string; phone: string | null;
  petsTotal: number; petsTruncatedCount: number; pets: OverduePet[];
}
export interface OverdueQueueResult {
  groups: OverdueCustomerGroup[]; totalGroups: number; page: number; pageSize: number;
  thresholdDays: number; filter: string;
}

export type OverdueFilter = "default" | "without_upcoming" | "never_groomed";

export async function loadOverdueQueue(
  supabase: SupabaseClient,
  options: { branchId?: string | null; search?: string | null; filter?: OverdueFilter; page?: number; pageSize?: number },
): Promise<OverdueQueueResult> {
  const result = await supabase.schema("app").rpc("list_overdue_customers", {
    p_branch: options.branchId ?? null,
    p_search: options.search ?? null,
    p_filter: options.filter ?? "default",
    p_page: options.page ?? 1,
    p_page_size: options.pageSize ?? 25,
  });
  if (result.error) throw new Error(`overdue_queue_failed:${result.error.message}`);
  const data = result.data as Record<string, unknown>;
  const groups = (data.groups as Array<Record<string, unknown>>).map((row) => ({
    customerId: String(row.customer_id), customerName: String(row.customer_name), phone: row.phone ? String(row.phone) : null,
    petsTotal: Number(row.pets_total), petsTruncatedCount: Number(row.pets_truncated_count),
    pets: (row.pets as Array<Record<string, unknown>>).map((pet) => ({
      petId: String(pet.pet_id), petName: String(pet.pet_name),
      lastGroomedAt: pet.last_groomed_at ? String(pet.last_groomed_at) : null,
      daysSince: pet.days_since === null || pet.days_since === undefined ? null : Number(pet.days_since),
      hasUpcomingBooking: Boolean(pet.has_upcoming_booking), anomalyFutureDated: Boolean(pet.anomaly_future_dated),
    })),
  }));
  return {
    groups, totalGroups: Number(data.total_groups), page: Number(data.page), pageSize: Number(data.page_size),
    thresholdDays: Number(data.threshold_days), filter: String(data.filter),
  };
}

export interface RenewalMembership {
  id: string; petName: string | null; serviceName: string | null; packageName: string;
  recurrenceInterval: string; isRecurring: boolean; status: string; expiresAt: string | null;
  sessionsRemaining: number; reservedCount: number; consumedCount: number; availableCount: number;
  isExpired: boolean; isExpiringSoon: boolean; noAvailableSessions: boolean; allReserved: boolean; oneAvailable: boolean;
}
export interface RenewalCustomerGroup {
  customerId: string; customerName: string; phone: string | null; memberships: RenewalMembership[];
}
export interface RenewalQueueResult {
  groups: RenewalCustomerGroup[]; totalGroups: number; page: number; pageSize: number; view: string;
}

export type RenewalView = "actionable" | "historical" | "all";

export async function loadRenewalQueue(
  supabase: SupabaseClient,
  options: { view?: RenewalView; search?: string | null; includeTokens?: boolean; page?: number; pageSize?: number },
): Promise<RenewalQueueResult> {
  const result = await supabase.schema("app").rpc("list_renewal_queue", {
    p_view: options.view ?? "actionable",
    p_search: options.search ?? null,
    p_include_tokens: options.includeTokens ?? false,
    p_page: options.page ?? 1,
    p_page_size: options.pageSize ?? 25,
  });
  if (result.error) throw new Error(`renewal_queue_failed:${result.error.message}`);
  const data = result.data as Record<string, unknown>;
  const groups = (data.groups as Array<Record<string, unknown>>).map((row) => ({
    customerId: String(row.customer_id), customerName: String(row.customer_name), phone: row.phone ? String(row.phone) : null,
    memberships: (row.memberships as Array<Record<string, unknown>>).map((m) => ({
      id: String(m.id), petName: m.pet_name ? String(m.pet_name) : null, serviceName: m.service_name ? String(m.service_name) : null,
      packageName: String(m.package_name), recurrenceInterval: String(m.recurrence_interval), isRecurring: Boolean(m.is_recurring),
      status: String(m.status), expiresAt: m.expires_at ? String(m.expires_at) : null, sessionsRemaining: Number(m.sessions_remaining),
      reservedCount: Number(m.reserved_count), consumedCount: Number(m.consumed_count), availableCount: Number(m.available_count),
      isExpired: Boolean(m.is_expired), isExpiringSoon: Boolean(m.is_expiring_soon), noAvailableSessions: Boolean(m.no_available_sessions),
      allReserved: Boolean(m.all_reserved), oneAvailable: Boolean(m.one_available),
    })),
  }));
  return { groups, totalGroups: Number(data.total_groups), page: Number(data.page), pageSize: Number(data.page_size), view: String(data.view) };
}
