/**
 * Function index:
 * - loadBranchTimezones: maps every organization branch id to its configured time zone.
 * - resolveDefaultTimezone: picks the explicit default-branch time zone.
 *
 * Records carrying a `branch_id` are formatted in that branch's zone. Organization-level
 * records that carry no branch — timeline events, for instance — are formatted in the
 * explicitly resolved default-branch zone rather than the server process zone, which is
 * whatever the deployment happens to be set to and is UTC on Vercel.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Last-resort zone used only when an organization has no readable branch at all, which
 * the schema makes unlikely (every booking requires a branch). Named so it is obvious in
 * a diff that reaching this value means branch resolution failed, not that UTC was chosen.
 */
export const UNRESOLVED_TIMEZONE_FALLBACK = "UTC";

export interface BranchTimezoneContext {
  byBranchId: ReadonlyMap<string, string>;
  defaultTimezone: string;
  defaultBranchId: string | null;
}

export function resolveDefaultTimezone(
  rows: readonly { id: string; timezone: string; is_default: boolean }[],
): { timezone: string; branchId: string | null } {
  const explicitDefault = rows.find((row) => row.is_default);
  const chosen = explicitDefault ?? rows[0];
  return chosen ? { timezone: chosen.timezone, branchId: chosen.id } : { timezone: UNRESOLVED_TIMEZONE_FALLBACK, branchId: null };
}

export async function loadBranchTimezones(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<BranchTimezoneContext> {
  const { data, error } = await supabase
    .from("branches")
    .select("id,timezone,is_default")
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("name");
  if (error) throw new Error(`branch_timezones_failed:${error.message}`);

  const rows = (data ?? []).flatMap((row) =>
    typeof row.id === "string" && typeof row.timezone === "string"
      ? [{ id: row.id, timezone: row.timezone, is_default: row.is_default === true }]
      : [],
  );
  const fallback = resolveDefaultTimezone(rows);
  return {
    byBranchId: new Map(rows.map((row) => [row.id, row.timezone])),
    defaultTimezone: fallback.timezone,
    defaultBranchId: fallback.branchId,
  };
}
