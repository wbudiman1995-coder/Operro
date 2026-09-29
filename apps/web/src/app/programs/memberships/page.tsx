/** Membership administration (section 25): filterable list, urgency, renew/archive, and reconciliation (section 26). */
import Link from "next/link";

import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { MembershipFilterList } from "@/components/membership-filter-list";
import { RestrictedNotice } from "@/components/restricted-notice";
import { loadMembershipAdministrationWorkspace } from "@/lib/membership-admin";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Administrasi paket" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Section 35 deep link: an internal-only return path, never an arbitrary redirect target.
 * Must start with exactly one `/` (rejects `//host/evil`, `https://...`, `javascript:...`).
 */
function sanitizeReturnTo(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^\/[^/\s][^\s]*$/.test(value)) return null;
  return value;
}

export default async function MembershipsPage({ searchParams }: { searchParams: Promise<{ membershipId?: string; return?: string }> }) {
  const params = await searchParams;
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["membership.read"]) {
    return <WorkspaceShell {...workspace} activePath="/programs">
      <PageHeader eyebrow="Retensi pelanggan" title="Administrasi paket" description="Kelola status, perpanjangan, dan rekonsiliasi saldo paket pelanggan." />
      <div className="mt-7"><RestrictedNotice title="Tidak memiliki akses" description="Peran ini memerlukan membership.read untuk melihat administrasi paket." /></div>
    </WorkspaceShell>;
  }
  const { rows, branches, services } = await loadMembershipAdministrationWorkspace(workspace.supabase, workspace.activeOrganization.id);

  const requestedId = params.membershipId && UUID.test(params.membershipId) ? params.membershipId : null;
  // Authorized lookup is implicit: `rows` already comes from a query scoped to this org's
  // RLS. A requested id that belongs to another org, or does not exist, is simply absent
  // from `rows` -- the UI shows one generic "not found" message either way, so a wrong-org
  // id never reveals that a private record exists elsewhere.
  const focusFound = requestedId ? rows.some((row) => row.id === requestedId) : true;
  const returnTo = sanitizeReturnTo(params.return);

  return <WorkspaceShell {...workspace} activePath="/programs">
    <PageHeader
      eyebrow="Retensi pelanggan"
      title="Administrasi paket"
      description="Kelola status, perpanjangan, dan rekonsiliasi saldo paket pelanggan. Setiap perbaikan saldo memerlukan izin terpisah dan tercatat di ledger."
      action={<Link href={returnTo ?? "/programs"} className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700">{returnTo ? "Kembali ke antrean" : "Kembali ke ringkasan"}</Link>}
    />
    {requestedId && !focusFound ? (
      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs font-semibold text-amber-800">
        Rekaman membership yang diminta tidak ditemukan atau Anda tidak memiliki akses ke rekaman tersebut.
      </div>
    ) : null}
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
      {rows.length === 0
        ? <div className="p-5"><EmptyState title="Belum ada paket pelanggan" description="Paket yang terjual melalui invoice akan muncul di sini." /></div>
        : <MembershipFilterList rows={rows} canManage={workspace.capabilities["membership.manage"]} branches={branches} services={services} focusMembershipId={focusFound ? requestedId : null} returnTo={returnTo} />}
    </section>
  </WorkspaceShell>;
}
