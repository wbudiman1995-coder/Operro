/**
 * Function index:
 * - loadAccessibleOrganizations: reads live user memberships under RLS.
 * - normalizeMembershipRows: validates the untyped Supabase relation payload.
 * - findActiveOrganization: verifies a JWT organization claim against live access.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type OrganizationStatus = "trial" | "active";

export interface AccessibleOrganization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  vertical: string | null;
  membershipId: string;
  membershipCreatedAt: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  vertical: string | null;
  deleted_at: null;
}

const OPERATIONAL_STATUSES = new Set<OrganizationStatus>(["trial", "active"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeOrganization(value: unknown): OrganizationRow | null {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (!isRecord(candidate)) {
    return null;
  }

  const { id, name, slug, status, vertical, deleted_at: deletedAt } = candidate;

  if (
    !isString(id) ||
    !isString(name) ||
    !isString(slug) ||
    (status !== "trial" && status !== "active") ||
    (vertical !== null && typeof vertical !== "string") ||
    deletedAt !== null
  ) {
    return null;
  }

  return {
    id,
    name,
    slug,
    status,
    vertical,
    deleted_at: null,
  };
}

function normalizeMembershipRows(value: unknown): AccessibleOrganization[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const organizations: AccessibleOrganization[] = [];

  for (const row of value) {
    if (!isRecord(row)) {
      continue;
    }

    const organization = normalizeOrganization(row.organizations);
    const membershipId = row.id;
    const organizationId = row.organization_id;
    const membershipCreatedAt = row.created_at;

    if (
      !organization ||
      !isString(membershipId) ||
      !isString(organizationId) ||
      !isString(membershipCreatedAt) ||
      organization.id !== organizationId ||
      !OPERATIONAL_STATUSES.has(organization.status)
    ) {
      continue;
    }

    organizations.push({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      vertical: organization.vertical,
      membershipId,
      membershipCreatedAt,
    });
  }

  return organizations;
}

export async function loadAccessibleOrganizations(
  supabase: SupabaseClient,
  userId: string,
): Promise<AccessibleOrganization[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select(
      `
        id,
        organization_id,
        created_at,
        organizations!inner (
          id,
          name,
          slug,
          status,
          vertical,
          deleted_at
        )
      `,
    )
    .eq("user_id", userId)
    .eq("status", "active")
    .is("deleted_at", null)
    .in("organizations.status", ["trial", "active"])
    .is("organizations.deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`organization_resolution_failed:${error.message}`);
  }

  return normalizeMembershipRows(data);
}

export function findActiveOrganization(
  organizations: readonly AccessibleOrganization[],
  activeOrganizationId: string | null,
): AccessibleOrganization | null {
  if (!activeOrganizationId) {
    return null;
  }

  return (
    organizations.find(
      (organization) => organization.id === activeOrganizationId,
    ) ?? null
  );
}
