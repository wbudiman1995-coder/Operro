/**
 * Marketing spend (parity #1). A manual, immutable ledger of what was spent per customer source; the dashboard compares it with
 * cash collected from the period's new customers. Reading needs finance.read and every branch; writing needs finance.manage.
 */
import { MarketingSpendPanel } from "@/components/marketing-spend-panel";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadBranchAccess } from "@/lib/authorization";
import { loadBranchTimezones } from "@/lib/branch-context";
import { loadSourceSuggestions } from "@/lib/business-defaults";
import { loadMarketingSpend, type MarketingSpend, type SpendCursor } from "@/lib/marketing-spend";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { zonedDayISO } from "@/lib/timezone";

export const metadata = { title: "Biaya pemasaran" };
export const dynamic = "force-dynamic";

const CURSOR = /^(\d{4}-\d{2}-\d{2})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function parseCursor(raw: string | undefined): SpendCursor | null {
  const match = raw ? CURSOR.exec(raw) : null;
  return match ? { spentOn: match[1], id: match[2] } : null;
}

export default async function MarketingSpendPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const branchAccess = await loadBranchAccess(workspace.supabase, workspace.activeOrganization.id, workspace.activeOrganization.membershipId);
  if (!workspace.capabilities["finance.read"] || !branchAccess.all) {
    return <WorkspaceShell {...workspace} activePath="/finance"><RestrictedNotice title="Tidak ada izin melihat biaya pemasaran" description="Biaya pemasaran berlaku untuk seluruh bisnis dan memerlukan izin finance.read dengan akses semua cabang." /></WorkspaceShell>;
  }
  const params = await searchParams;
  const [timezones, sourceLabels] = await Promise.all([loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id), loadSourceSuggestions(workspace.supabase)]);
  let spend: MarketingSpend | null = null;
  let error: string | null = null;
  try {
    spend = await loadMarketingSpend(workspace.supabase, parseCursor(params.cursor));
  } catch (cause) {
    console.error("marketing_spend_load_failed", cause instanceof Error ? cause.message : "unknown");
    error = "Biaya pemasaran belum dapat dimuat. Ini bukan tanda tidak ada biaya: coba muat ulang halaman.";
  }
  const today = zonedDayISO(new Date(), timezones.defaultTimezone);
  const requestKeys = { entry: crypto.randomUUID(), reversals: Object.fromEntries((spend?.entries ?? []).map((entry) => [entry.id, crypto.randomUUID()])) };
  const nextHref = spend?.nextCursor ? `/finance/marketing?cursor=${spend.nextCursor.spentOn}_${spend.nextCursor.id}` : null;
  return <WorkspaceShell {...workspace} activePath="/finance">
    <PageHeader eyebrow="Kontrol biaya" title="Biaya pemasaran" description="Catatan biaya per sumber pelanggan yang tidak dapat diubah, dipakai untuk ROI sederhana di dasbor." />
    <MarketingSpendPanel spend={spend} canManage={Boolean(workspace.capabilities["finance.manage"])} today={today} requestKeys={requestKeys} error={error} nextHref={nextHref} sourceLabels={sourceLabels} />
  </WorkspaceShell>;
}
