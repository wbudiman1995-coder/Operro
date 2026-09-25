/**
 * Function index:
 * - loadCapabilities: resolves a set of permission keys via app.has_permission.
 * - loadBranchAccess: resolves which branches the active membership may actually see.
 * - filterAccessibleBranches: pure helper applying a branch-access decision to a list.
 * - explainAuthorization: diagnostic passthrough to app.explain_authorization.
 *
 * Why this exists: row level security answers an unauthorized read with an empty set,
 * not an error. Rendering that directly turns "you may not see finances" into
 * "this customer has spent nothing", which is worse than showing nothing at all. Every
 * permission-bearing surface therefore resolves its capability up front and renders an
 * explicit restricted state instead of a zero or an empty list.
 *
 * `app.has_permission` and `app.has_branch` are used rather than the `tenant_*` variants
 * because the base RLS policies on the data tables call these, so presentation and data
 * visibility agree — including the platform-admin bypass.
 *
 * FROZEN-SCHEMA PERMISSION MISMATCH (verified in migration 20260721001100, lines 326-395).
 * The capability-policy generator builds ONE write permission per table and applies it to
 * INSERT, UPDATE and DELETE alike. The `bookings` row is
 * `('bookings','scheduling','booking.read','booking.create',false)`, so the restrictive
 * policy `bookings_write_upd` requires `booking.create` — not `booking.update` — for a
 * direct UPDATE. `booking_resources` carries `booking.update`.
 *
 * A reschedule therefore needs BOTH capabilities for its two writes to pass RLS. Operro
 * gates the operation on the semantically correct `booking.update` and additionally
 * requires `booking.create` so the request cannot fail halfway through with an opaque
 * policy error. This is documented rather than corrected: fixing it would mean editing a
 * frozen migration.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const CAPABILITY_KEYS = [
  "booking.read",
  "customer.read",
  "customer.manage",
  "finance.read",
  "inventory.read",
  "membership.read",
  "membership.manage",
  "payroll.read",
  "payroll.manage",
  "reports.view",
  "service.manage",
  "task.manage",
  // Batch 1B write capabilities.
  "booking.update",
  "booking.create",
  "booking.cancel",
  "resource.manage",
  "invoice.issue",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type CapabilityMap = Record<CapabilityKey, boolean>;

export const BRANCHES_ALL_PERMISSION = "branches.all";

/**
 * Resolves every capability key in ONE round trip via `app.list_my_permissions`,
 * which runs the identical join/filter logic as `app.has_permission` for every
 * key the caller holds at once (see migration 20260917100300_batch_permissions.sql).
 * This replaces 13 permission RPC calls with one database round trip. Route
 * timing still needs to be measured separately before assigning a broader
 * navigation improvement to this change.
 *
 * A failed batch call is treated as fully denied, matching the previous
 * per-key behavior: a transport or policy error must never open a surface it
 * would otherwise close.
 */
export async function loadCapabilities(
  supabase: SupabaseClient,
  keys: readonly CapabilityKey[] = CAPABILITY_KEYS,
): Promise<CapabilityMap> {
  const map = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as CapabilityMap;
  const { data, error } = await supabase.schema("app").rpc("list_my_permissions");
  if (error || !data) return map;
  const granted = new Set((data as Array<{ perm: string }>).map((row) => row.perm));
  for (const key of keys) map[key] = granted.has(key);
  return map;
}

export interface BranchAccess {
  /** True when the membership holds `branches.all` and may see every organization branch. */
  all: boolean;
  /** Explicitly granted branch ids. Only meaningful when `all` is false. */
  ids: ReadonlySet<string>;
}

/**
 * Resolves real branch visibility.
 *
 * The `branches` table's own RLS is organization-scoped and does not apply
 * `app.has_branch`, so an organization's full branch list is readable even by a
 * membership restricted to one branch. Listing branches straight from that read would
 * therefore offer branches the user cannot work in. Access is resolved here from
 * `branches.all` plus `membership_branch_access`, which is what `app.has_branch` itself
 * consults.
 */
export async function loadBranchAccess(
  supabase: SupabaseClient,
  organizationId: string,
  membershipId: string,
): Promise<BranchAccess> {
  const [allResult, grantResult] = await Promise.all([
    supabase.schema("app").rpc("has_permission", { perm: BRANCHES_ALL_PERMISSION }),
    supabase
      .from("membership_branch_access")
      .select("branch_id")
      .eq("organization_id", organizationId)
      .eq("membership_id", membershipId),
  ]);

  if (allResult.error === null && allResult.data === true) return { all: true, ids: new Set() };
  if (grantResult.error) throw new Error(`branch_access_failed:${grantResult.error.message}`);

  return {
    all: false,
    ids: new Set((grantResult.data ?? []).flatMap((row) => (typeof row.branch_id === "string" ? [row.branch_id] : []))),
  };
}

export function isBranchAccessible(access: BranchAccess, branchId: string): boolean {
  return access.all || access.ids.has(branchId);
}

export function filterAccessibleBranches<T extends { id: string }>(branches: readonly T[], access: BranchAccess): T[] {
  return access.all ? [...branches] : branches.filter((branch) => access.ids.has(branch.id));
}

export async function explainAuthorization(
  supabase: SupabaseClient,
  options: { module?: string; permission?: string; branchId?: string },
): Promise<{ allowed: boolean; reason: string }> {
  const { data, error } = await supabase.schema("app").rpc("explain_authorization", {
    p_module: options.module ?? null,
    p_perm: options.permission ?? null,
    p_branch: options.branchId ?? null,
  });
  if (error) return { allowed: false, reason: `explain_failed:${error.message}` };
  const payload = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  return {
    allowed: payload.allowed === true,
    reason: typeof payload.reason === "string" ? payload.reason : "unknown",
  };
}

/** Chooses a useful landing page from live capabilities after organization resolution. */
export function defaultWorkspacePath(capabilities: CapabilityMap): string {
  const hasManagementSurface =
    capabilities["booking.create"] ||
    capabilities["customer.read"] ||
    capabilities["finance.read"] ||
    capabilities["inventory.read"] ||
    capabilities["membership.read"] ||
    capabilities["payroll.read"] ||
    capabilities["reports.view"] ||
    capabilities["service.manage"] ||
    capabilities["task.manage"];
  if (hasManagementSurface) return "/dashboard";
  if (capabilities["booking.read"]) return "/my-schedule";
  return "/organizations";
}
