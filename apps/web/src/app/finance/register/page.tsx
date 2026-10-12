/**
 * P2 cash-control register (parity #31). Balances are the sum of declared movements per account and currency;
 * payments, refunds, expenses and payroll do not post here. Reading needs finance.read; writing needs finance.manage.
 */
import { CashRegisterPanel } from "@/components/cash-register-panel";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { filterAccessibleBranches, loadBranchAccess } from "@/lib/authorization";
import { loadBranchTimezones } from "@/lib/branch-context";
import { loadCashRegister, type CashRegister, type MovementCursor } from "@/lib/cash-register";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { zonedDayISO } from "@/lib/timezone";

export const metadata = { title: "Register kas" };
export const dynamic = "force-dynamic";

const CURSOR = /^(\d{4}-\d{2}-\d{2})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function parseCursor(raw: string | undefined): MovementCursor | null {
  const match = raw ? CURSOR.exec(raw) : null;
  return match ? { occurredOn: match[1], id: match[2] } : null;
}

export default async function CashRegisterPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["finance.read"]) {
    return <WorkspaceShell {...workspace} activePath="/finance"><RestrictedNotice title="Tidak ada izin melihat register kas" description="Register kas memerlukan izin finance.read." /></WorkspaceShell>;
  }
  const params = await searchParams;
  const [branchAccess, timezones, branchRows] = await Promise.all([
    loadBranchAccess(workspace.supabase, workspace.activeOrganization.id, workspace.activeOrganization.membershipId),
    loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id),
    workspace.supabase.from("branches").select("id,name").eq("organization_id", workspace.activeOrganization.id).is("deleted_at", null).order("name"),
  ]);
  const branches = filterAccessibleBranches((branchRows.data ?? []) as Array<{ id: string; name: string }>, branchAccess);
  let register: CashRegister | null = null;
  let error: string | null = null;
  try {
    register = await loadCashRegister(workspace.supabase, parseCursor(params.cursor));
  } catch (cause) {
    console.error("cash_register_load_failed", cause instanceof Error ? cause.message : "unknown");
    error = "Register kas belum dapat dimuat. Ini bukan tanda saldo nol: coba muat ulang halaman.";
  }
  const today = zonedDayISO(new Date(), timezones.defaultTimezone);
  const requestKeys = {
    movement: crypto.randomUUID(),
    reversals: Object.fromEntries((register?.movements ?? []).map((movement) => [movement.id, crypto.randomUUID()])),
  };
  const nextHref = register?.nextCursor ? `/finance/register?cursor=${register.nextCursor.occurredOn}_${register.nextCursor.id}` : null;
  return <WorkspaceShell {...workspace} activePath="/finance">
    <PageHeader eyebrow="Kontrol kas" title="Register kas" description="Akun kas, bank, dan e-wallet dengan mutasi yang tidak dapat diubah: saldo awal, modal, penarikan pemilik, dan kas masuk/keluar lain." />
    <CashRegisterPanel register={register} canManage={Boolean(workspace.capabilities["finance.manage"])} canCreateOrgWide={branchAccess.all} branches={branches} today={today} requestKeys={requestKeys} error={error} nextHref={nextHref} />
  </WorkspaceShell>;
}
