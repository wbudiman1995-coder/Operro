/** Membership administration (section 25): filterable list, urgency, renew/archive, and reconciliation (section 26). */
import Link from "next/link";

import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { MembershipFilterList } from "@/components/membership-filter-list";
import { loadMembershipAdministrationWorkspace } from "@/lib/membership-admin";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Administrasi paket" };

export default async function MembershipsPage() {
  const workspace = await requireActiveWorkspace();
  const { rows, branches, services } = await loadMembershipAdministrationWorkspace(workspace.supabase, workspace.activeOrganization.id);
  return <WorkspaceShell {...workspace} activePath="/programs">
    <PageHeader
      eyebrow="Retensi pelanggan"
      title="Administrasi paket"
      description="Kelola status, perpanjangan, dan rekonsiliasi saldo paket pelanggan. Setiap perbaikan saldo memerlukan izin terpisah dan tercatat di ledger."
      action={<Link href="/programs" className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700">Kembali ke ringkasan</Link>}
    />
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
      {rows.length === 0
        ? <div className="p-5"><EmptyState title="Belum ada paket pelanggan" description="Paket yang terjual melalui invoice akan muncul di sini." /></div>
        : <MembershipFilterList rows={rows} canManage={workspace.capabilities["membership.manage"]} branches={branches} services={services} />}
    </section>
  </WorkspaceShell>;
}
