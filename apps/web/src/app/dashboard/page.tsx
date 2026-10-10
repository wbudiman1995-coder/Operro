/**
 * Function index:
 * - DashboardPage: enforces authenticated and organization-scoped access before rendering the owner shell.
 */
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard-shell";
import { defaultWorkspacePath, loadBranchAccess } from "@/lib/authorization";
import { loadBranchTimezones } from "@/lib/branch-context";
import { loadDashboardPerformance } from "@/lib/dashboard-performance";
import { resolveDashboardPeriod, type DashboardPeriodInput } from "@/lib/dashboard-period";
import { loadDashboardCardSettings, loadDashboardData } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<DashboardPeriodInput> }) {
  const workspace = await requireActiveWorkspace();
  const { activeOrganization, capabilities, supabase } = workspace;
  const landingPath = defaultWorkspacePath(capabilities);
  if (landingPath !== "/dashboard") redirect(landingPath);
  const [branchAccess, branchTimezones, dashboardCards, query] = await Promise.all([
    loadBranchAccess(supabase, activeOrganization.id, activeOrganization.membershipId),
    loadBranchTimezones(supabase, activeOrganization.id),
    loadDashboardCardSettings(supabase, activeOrganization.id),
    searchParams,
  ]);
  const dashboardTimeZone = branchAccess.all || (branchTimezones.defaultBranchId && branchAccess.ids.has(branchTimezones.defaultBranchId))
    ? branchTimezones.defaultTimezone
    : [...branchAccess.ids].flatMap((id) => branchTimezones.byBranchId.get(id) ?? []).sort()[0] ?? branchTimezones.defaultTimezone;
  const resolution = resolveDashboardPeriod(query, new Date(), dashboardTimeZone);
  const [data, performance] = await Promise.all([
    loadDashboardData(supabase, activeOrganization.id, capabilities, branchAccess, dashboardTimeZone, dashboardCards),
    loadDashboardPerformance(supabase, capabilities, branchAccess, resolution.period, dashboardTimeZone, dashboardCards),
  ]);

  return (
    <DashboardShell
      organizations={workspace.organizations}
      activeOrganization={activeOrganization}
      userEmail={workspace.userEmail}
      data={data}
      capabilities={capabilities}
      dashboardCards={dashboardCards}
      period={resolution.period}
      periodError={resolution.ok ? null : resolution.message}
      performance={performance}
    />
  );
}
