/**
 * E3.4: read-only health and recovery-readiness surface for the business owner and the Operro platform owner.
 * A business owner sees their own workspace's counts and only the date/outcome of the last platform restore drill.
 */
import { HealthPanel } from "@/components/health-panel";
import { PageHeader } from "@/components/pilot-ui";
import { RecoveryDrillForm } from "@/components/recovery-drill-form";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { appVersion, deriveReadiness, loadHealth } from "@/lib/health";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Kesehatan & pemulihan" };
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const workspace = await requireActiveWorkspace();
  const [owner, platform] = await Promise.all([
    workspace.supabase.schema("app").rpc("is_business_owner_member", { p_org: workspace.activeOrganization.id }),
    workspace.supabase.schema("app").rpc("is_operro_owner"),
  ]);
  if (owner.data !== true) {
    return <WorkspaceShell {...workspace} activePath="/settings/health"><RestrictedNotice title="Hanya untuk pemilik" description="Kesehatan dan kesiapan pemulihan hanya tersedia bagi pemilik bisnis atau pemilik platform Operro." /></WorkspaceShell>;
  }
  let health: Awaited<ReturnType<typeof loadHealth>> | null = null;
  try {
    health = await loadHealth(workspace.supabase, workspace.capabilities);
  } catch (error) {
    console.error("health_page_failed", error);
  }
  const content = health
    ? <HealthPanel summary={health.summary} recovery={health.recovery} reconciliation={health.reconciliation} readiness={deriveReadiness(health.summary, health.recovery, health.reconciliation)} version={appVersion()} platform={platform.data === true} />
    : <p role="alert" className="mt-7 rounded-xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">Kesehatan belum dapat dimuat. Ini bukan tanda bahwa sistem sehat: coba lagi atau periksa dashboard penyedia.</p>;
  return <WorkspaceShell {...workspace} activePath="/settings/health">
    <PageHeader eyebrow="Pengaturan workspace" title="Kesehatan & kesiapan pemulihan" description="Ringkasan baca-saja dari data yang sudah disimpan Operro. Tidak membaca status penyedia dan tidak membuktikan pemulihan tanpa uji nyata." />
    {content}
    {platform.data === true ? <div className="mt-6"><RecoveryDrillForm /></div> : null}
  </WorkspaceShell>;
}
