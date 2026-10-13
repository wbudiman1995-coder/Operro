/**
 * P5 business configuration: the one HomePaw setting Operro read but could not write (branch calendar hours), plus a plain map of
 * where every other HomePaw setting lives in Operro, who may change it, and whether it is organization-wide, per branch,
 * personal or platform-level. There is no generic settings editor on this page.
 */
import Link from "next/link";

import { BranchHoursForm } from "@/components/branch-hours-form";
import { BranchCreateForm } from "@/components/branch-create-form";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadBranchAccess } from "@/lib/authorization";
import { BusinessDefaultsForm } from "@/components/business-defaults-form";
import { loadBusinessDefaults, NO_DEFAULTS, type BusinessDefaults } from "@/lib/business-defaults";
import { loadBranchHours, SETTINGS_MAP, type BranchHours } from "@/lib/business-settings";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Pengaturan bisnis" };
export const dynamic = "force-dynamic";

const SCOPE_TONE: Record<string, string> = { Organisasi: "bg-emerald-50 text-emerald-800", Cabang: "bg-sky-50 text-sky-800", Pribadi: "bg-violet-50 text-violet-800", Platform: "bg-slate-100 text-slate-700" };

export default async function BusinessSettingsPage() {
  const workspace = await requireActiveWorkspace();
  const caps = workspace.capabilities;
  if (!caps["settings.manage"] && !caps["branches.manage"]) {
    return <WorkspaceShell {...workspace} activePath="/settings/business"><RestrictedNotice title="Tidak ada akses pengaturan bisnis" description="Halaman ini memerlukan settings.manage atau branches.manage." /></WorkspaceShell>;
  }
  const [access, owner] = await Promise.all([
    loadBranchAccess(workspace.supabase, workspace.activeOrganization.id, workspace.activeOrganization.membershipId),
    workspace.supabase.schema("app").rpc("is_business_owner_member", { p_org: workspace.activeOrganization.id }),
  ]);
  let branches: BranchHours[] | null = null;
  try { branches = await loadBranchHours(workspace.supabase, workspace.activeOrganization.id, access); }
  catch (error) { console.error("business_settings_branches_failed", error instanceof Error ? error.message : "unknown"); }
  let defaults: BusinessDefaults | null = NO_DEFAULTS;
  try { defaults = await loadBusinessDefaults(workspace.supabase); }
  catch (error) { console.error("business_defaults_load_failed", error instanceof Error ? error.message : "unknown"); defaults = null; }
  const canEdit = owner.data === true || Boolean(caps["branches.manage"]);
  const canEditDefaults = owner.data === true || Boolean(caps["settings.manage"]);
  return <WorkspaceShell {...workspace} activePath="/settings/business">
    <PageHeader eyebrow="Pengaturan workspace" title="Pengaturan bisnis" description="Jam kalender per cabang, dan peta lokasi setiap pengaturan bisnis: milik organisasi, cabang, pribadi, atau platform." action={<Link href="/dashboard" className="rounded-lg border px-3 py-2 text-xs font-bold">Kembali</Link>} />
    <section className="mt-7 rounded-2xl border bg-white p-5" aria-label="Jam kalender">
      <h2 className="font-bold">Jam kalender per cabang</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">Mengatur rentang jam pada sumbu waktu kalender (kelipatan 15 menit, minimal 2 jam). Booking di luar rentang tetap tampil karena kalender melebar menyesuaikan; jam ini tidak mengubah ketersediaan groomer, rekomendasi slot, atau booking yang sudah ada. Jika dua orang mengubah bersamaan, simpanan kedua ditolak dan Anda diminta memuat ulang.</p>
      <div className="mt-4 space-y-3">
        {branches === null ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs font-semibold text-rose-700">Daftar cabang belum dapat dimuat. Ini bukan berarti tidak ada cabang: coba muat ulang halaman.</p>
          : branches.length === 0 ? <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">Tidak ada cabang yang dapat Anda akses.</p>
          : branches.map((branch) => <BranchHoursForm key={`${branch.id}:${branch.updatedAt}`} branch={branch} canEdit={canEdit} />)}
        <BranchCreateForm canEdit={canEdit} />
      </div>
    </section>
    <section className="mt-6 rounded-2xl border bg-white p-5" aria-label="Bawaan bisnis">
      <h2 className="font-bold">Bawaan bisnis</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">Dua pengaturan HomePaw yang diadopsi sebagai bawaan yang aman: saran label sumber pelanggan dan jatuh tempo bawaan invoice baru. Keduanya divalidasi, dicatat, dan dilindungi dari penyimpanan bersamaan (orang kedua diminta memuat ulang). Tidak mengubah data yang sudah ada.</p>
      <div className="mt-4">
        {defaults === null
          ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs font-semibold text-rose-700">Bawaan bisnis belum dapat dimuat. Ini bukan berarti belum ada bawaan: coba muat ulang halaman.</p>
          : <BusinessDefaultsForm key={defaults.version} defaults={defaults} canEdit={canEditDefaults} />}
      </div>
    </section>
    <section className="mt-6 rounded-2xl border bg-white p-5" aria-label="Peta pengaturan">
      <h2 className="font-bold">Di mana setiap pengaturan berada</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">Setiap pengaturan punya jalur ubah sendiri yang divalidasi dan dicatat; tidak ada editor JSON bebas. Pengaturan pribadi hanya memengaruhi tampilan Anda sendiri, dan pengaturan platform hanya dapat diubah pemilik platform Operro.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-[11px] uppercase text-slate-400"><tr><th className="py-2 pr-3">Pengaturan HomePaw</th><th className="pr-3">Di Operro</th><th className="pr-3">Lingkup</th><th className="pr-3">Siapa</th><th>Catatan</th></tr></thead>
          <tbody className="divide-y divide-slate-100 align-top">
            {SETTINGS_MAP.map((row) => (
              <tr key={row.homepaw}>
                <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">{row.homepaw}</td>
                <td className="pr-3 font-semibold text-slate-800">{row.href ? <Link href={row.href} className="underline decoration-slate-300 underline-offset-2">{row.label}</Link> : row.label}</td>
                <td className="pr-3"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${SCOPE_TONE[row.scope]}`}>{row.scope}</span></td>
                <td className="pr-3 text-slate-600">{row.who}</td>
                <td className="text-slate-600">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  </WorkspaceShell>;
}
