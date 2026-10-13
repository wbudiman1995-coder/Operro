/**
 * Cash account mappings (parity #31): where payments, expenses and payroll land. Immutable history; a newer row supersedes an older
 * one. Reading needs finance.read; writing needs finance.manage.
 */
import Link from "next/link";

import { CashMappingForm } from "@/components/cash-mapping-form";
import { CashMappingList } from "@/components/cash-on-hand-panel";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { filterAccessibleBranches, loadBranchAccess } from "@/lib/authorization";
import { loadBranchTimezones } from "@/lib/branch-context";
import { parsePositionRows } from "@/lib/cash-register";
import { loadCashMappings, type CashMapping } from "@/lib/cash-mapping";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { zonedDayISO } from "@/lib/timezone";

export const metadata = { title: "Pemetaan kas" };
export const dynamic = "force-dynamic";

export default async function CashMappingPage() {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["finance.read"]) {
    return <WorkspaceShell {...workspace} activePath="/finance"><RestrictedNotice title="Tidak ada izin melihat pemetaan kas" description="Pemetaan kas memerlukan izin finance.read." /></WorkspaceShell>;
  }
  const [branchAccess, timezones, branchRows, positions] = await Promise.all([
    loadBranchAccess(workspace.supabase, workspace.activeOrganization.id, workspace.activeOrganization.membershipId),
    loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id),
    workspace.supabase.from("branches").select("id,name").eq("organization_id", workspace.activeOrganization.id).is("deleted_at", null).order("name"),
    workspace.supabase.schema("app").rpc("cash_register_position", { p_as_of: null }),
  ]);
  const branches = filterAccessibleBranches((branchRows.data ?? []) as Array<{ id: string; name: string }>, branchAccess);
  const accounts = positions.error ? [] : parsePositionRows(positions.data).filter((account) => account.status === "active");
  let mappings: CashMapping[] = [];
  let error: string | null = positions.error ? "Daftar akun belum dapat dimuat. Coba muat ulang halaman." : null;
  try {
    mappings = await loadCashMappings(workspace.supabase);
  } catch (cause) {
    console.error("cash_mappings_load_failed", cause instanceof Error ? cause.message : "unknown");
    error = "Riwayat pemetaan belum dapat dimuat. Ini bukan tanda belum ada pemetaan: coba muat ulang halaman.";
  }
  const today = zonedDayISO(new Date(), timezones.defaultTimezone);
  const canManage = Boolean(workspace.capabilities["finance.manage"]);
  return <WorkspaceShell {...workspace} activePath="/finance">
    <PageHeader eyebrow="Kontrol kas" title="Pemetaan kas" description="Tentukan akun tempat pembayaran, pengeluaran, dan gaji masuk atau keluar, mulai tanggal tertentu." action={<Link href="/finance/register" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-800">Kembali ke register</Link>} />
    <div className="mt-6 space-y-6">
      <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
        Pemetaan menentukan arus mana yang ikut dihitung ke saldo sebuah akun, sejak tanggal berlaku. Sebelum tanggal itu tidak ada yang dihitung, jadi catat saldo awal akun pada tanggal yang sama. Pemetaan tidak dapat diubah atau dihapus; pemetaan yang lebih baru menggantikannya dan riwayat tetap tersimpan. Pemetaan cabang menang atas pemetaan seluruh cabang.
      </p>
      {error ? <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</p> : null}
      {canManage ? (
        <section aria-label="Tambah pemetaan" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="font-bold">Tambah pemetaan</h2>
          <p className="mt-1 text-xs text-slate-500">Akun satu cabang hanya menerima arus cabang itu. Pemetaan seluruh cabang hanya dapat mengisi akun seluruh cabang dan memerlukan akses semua cabang. Pilih “Hentikan pemetaan” untuk berhenti menghitung arus itu mulai tanggal berlaku.</p>
          <div className="mt-4"><CashMappingForm accounts={accounts.map((account) => ({ id: account.id, name: account.name, currency: account.currency, branchId: account.branchId }))} branches={branches} canMapOrgWide={branchAccess.all} initialKey={crypto.randomUUID()} today={today} /></div>
        </section>
      ) : <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">Peran Anda dapat melihat pemetaan, tetapi tidak memiliki finance.manage untuk mengubahnya.</p>}
      <section aria-label="Riwayat pemetaan" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="font-bold">Riwayat pemetaan</h2>
        <CashMappingList mappings={mappings} accountNames={new Map(accounts.map((account) => [account.id, account.name]))} branchNames={new Map(branches.map((branch) => [branch.id, branch.name]))} />
      </section>
    </div>
  </WorkspaceShell>;
}
