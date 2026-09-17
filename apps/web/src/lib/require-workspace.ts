/**
 * Function index:
 * - requireActiveWorkspace: centralizes authenticated, active-organization route protection.
 */
import { cache } from "react";
import { redirect } from "next/navigation";

import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
import { createClient } from "@/lib/supabase/server";

/**
 * Wrapped in React `cache()` so every call within the same request/render
 * pass (a page plus whatever shared components it renders) resolves auth,
 * membership and capabilities once for callers that use this helper. Some
 * routes still have inline auth loading and can be migrated separately after
 * route timing identifies whether that work is worthwhile.
 */
export const requireActiveWorkspace = cache(async function requireActiveWorkspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context) redirect("/login");
  if (!context.activeOrganization) redirect("/organizations");
  const capabilities = await loadCapabilities(supabase);
  return { supabase, organizations: context.organizations, activeOrganization: context.activeOrganization, userEmail: context.user.email ?? "Akun Operro", userId: context.user.id, capabilities };
});
