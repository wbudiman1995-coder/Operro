/**
 * Function index:
 * - DashboardPage: enforces authenticated and organization-scoped access before rendering the owner shell.
 */
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard-shell";
import { NoOrganizationState } from "@/components/no-organization-state";
import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);

  if (!context) {
    return redirect("/login");
  }

  if (context.organizations.length === 0) {
    return <NoOrganizationState email={context.user.email ?? "akun Operro"} />;
  }

  const activeOrganization = context.activeOrganization;

  if (!activeOrganization) {
    return redirect("/organizations");
  }

  return (
    <DashboardShell
      organizations={context.organizations}
      activeOrganization={activeOrganization}
      userEmail={context.user.email ?? "Akun Operro"}
    />
  );
}
