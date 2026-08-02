/**
 * Function index:
 * - requireActiveWorkspace: centralizes authenticated, active-organization route protection.
 */
import { redirect } from "next/navigation";

import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export async function requireActiveWorkspace() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context) redirect("/login");
  if (!context.activeOrganization) redirect("/organizations");
  return { supabase, organizations: context.organizations, activeOrganization: context.activeOrganization, userEmail: context.user.email ?? "Akun Operro" };
}
