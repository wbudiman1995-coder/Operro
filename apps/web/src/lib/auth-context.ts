/**
 * Function index:
 * - loadAuthContext: verifies Supabase identity, loads accessible organizations, and resolves the active claim.
 * - readStringClaim: safely reads custom string claims without trusting arbitrary JWT payload shapes.
 */
import { cache } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import {
  findActiveOrganization,
  loadAccessibleOrganizations,
  type AccessibleOrganization,
} from "@/lib/organizations";

export interface AuthContext {
  user: User;
  organizations: AccessibleOrganization[];
  activeOrganization: AccessibleOrganization | null;
  activeOrganizationId: string | null;
}

function readStringClaim(
  claims: Record<string, unknown>,
  key: string,
): string | null {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Cached per-request (see createClient in lib/supabase/server.ts — every
 * caller now shares one client instance, which is what makes this cache
 * key/hit correctly instead of re-running on every call).
 */
export const loadAuthContext = cache(async function loadAuthContext(
  supabase: SupabaseClient,
): Promise<AuthContext | null> {
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    return null;
  }

  const claims = claimsData.claims as Record<string, unknown>;
  const subject = readStringClaim(claims, "sub");

  if (!subject) {
    return null;
  }

  const [
    {
      data: { user },
      error: userError,
    },
    organizations,
  ] = await Promise.all([
    supabase.auth.getUser(),
    loadAccessibleOrganizations(supabase, subject),
  ]);

  if (userError || !user || user.id !== subject) {
    return null;
  }

  const activeOrganizationId = readStringClaim(claims, "active_org_id");
  const activeOrganization = findActiveOrganization(
    organizations,
    activeOrganizationId,
  );

  return {
    user,
    organizations,
    activeOrganization,
    activeOrganizationId,
  };
});
