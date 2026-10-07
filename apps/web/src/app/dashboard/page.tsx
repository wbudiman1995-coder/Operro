/**
 * Function index:
 * - DashboardPage: enforces authenticated and organization-scoped access before rendering the owner shell.
 */
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard-shell";
import { defaultWorkspacePath, loadBranchAccess } from "@/lib/authorization";
import { loadBranchTimezones } from "@/lib/branch-context";
import { loadDashboardData } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const workspace = await requireActiveWorkspace();
  const { activeOrganization, capabilities, supabase } = workspace;
  const landingPath = defaultWorkspacePath(capabilities);
  if (landingPath !== "/dashboard") redirect(landingPath);
  const [branchAccess, branchTimezones] = await Promise.all([
    loadBranchAccess(supabase, activeOrganization.id, activeOrganization.membershipId),
    loadBranchTimezones(supabase, activeOrganization.id),
  ]);
  const dashboardTimeZone = branchAccess.all || (branchTimezones.defaultBranchId && branchAccess.ids.has(branchTimezones.defaultBranchId))
    ? branchTimezones.defaultTimezone
    : [...branchAccess.ids].flatMap((id) => branchTimezones.byBranchId.get(id) ?? []).sort()[0] ?? branchTimezones.defaultTimezone;
  const data = await loadDashboardData(supabase, activeOrganization.id, capabilities, branchAccess, dashboardTimeZone);

  return (
    <DashboardShell
      organizations={workspace.organizations}
      activeOrganization={activeOrganization}
      userEmail={workspace.userEmail}
      data={data}
      capabilities={capabilities}
    />
  );
}
