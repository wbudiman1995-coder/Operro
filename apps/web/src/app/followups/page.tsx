/**
 * Section 35: retention (overdue-pet follow-ups) and renewal queues.
 *
 * Two tabs sharing one page (`?tab=overdue|renewal`); every filter/branch/search/view/page
 * is a validated URL parameter so reload and browser Back both work with no client JS
 * required for navigation itself (only the message-draft/multi-select interactions are
 * client components). See docs/handoffs/S35-HANDOFF.md for the full requirement map.
 */
import Link from "next/link";

import { FollowupSettingsPanel } from "@/components/followup-settings-panel";
import { OverdueQueueList } from "@/components/overdue-queue";
import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { RenewalQueueList } from "@/components/renewal-queue";
import { WorkspaceShell } from "@/components/workspace-shell";
import {
  loadFollowupRetentionSettings, loadOverdueQueue, loadRenewalQueue,
  type OverdueFilter, type RenewalView,
} from "@/lib/followup-retention";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Follow-up & Perpanjangan" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OVERDUE_FILTERS: Array<{ value: OverdueFilter; label: string }> = [
  { value: "default", label: "Overdue" }, { value: "without_upcoming", label: "Tanpa booking mendatang" }, { value: "never_groomed", label: "Belum pernah digroom" },
];
const RENEWAL_VIEWS: Array<{ value: RenewalView; label: string }> = [
  { value: "actionable", label: "Perlu tindakan" }, { value: "historical", label: "Riwayat (diarsipkan)" }, { value: "all", label: "Semua" },
];

interface FollowupsSearchParams {
  tab?: string; branch?: string; search?: string; filter?: string; view?: string; tokens?: string; page?: string;
}

function buildHref(params: FollowupsSearchParams, overrides: Partial<FollowupsSearchParams>): string {
  const merged: FollowupsSearchParams = { ...params, ...overrides };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
  const qs = query.toString();
  return qs ? `/followups?${qs}` : "/followups";
}

export default async function FollowupsPage({ searchParams }: { searchParams: Promise<FollowupsSearchParams> }) {
  const params = await searchParams;
  const workspace = await requireActiveWorkspace();
  const tab = params.tab === "renewal" ? "renewal" : "overdue";
  const page = Math.max(1, Number(params.page) || 1);
  const search = params.search?.trim() || null;
  const canManageSettings = workspace.capabilities["settings.manage"];

  const [settings, branchesResult] = await Promise.all([
    loadFollowupRetentionSettings(workspace.supabase),
    workspace.supabase.from("branches").select("id,name").eq("organization_id", workspace.activeOrganization.id).eq("status", "active").is("deleted_at", null).order("name"),
  ]);
  const branches = branchesResult.data ?? [];

  const tabs = (
    <div className="flex flex-wrap gap-1 border-b border-slate-100 px-5 pt-4">
      <Link href={buildHref(params, { tab: "overdue", page: undefined })} className={`rounded-t-lg px-3 py-2 text-xs font-bold ${tab === "overdue" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>Hewan overdue</Link>
      <Link href={buildHref(params, { tab: "renewal", page: undefined })} className={`rounded-t-lg px-3 py-2 text-xs font-bold ${tab === "renewal" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>Perpanjangan membership</Link>
    </div>
  );

  const currentPath = buildHref(params, { tab });

  if (tab === "overdue" && !workspace.capabilities["booking.read"]) {
    return (
      <WorkspaceShell {...workspace} activePath="/followups">
        <PageHeader eyebrow="Retensi pelanggan" title="Follow-up & perpanjangan" description="Pelanggan yang perlu dihubungi dan membership yang perlu diperpanjang." />
        <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
          {tabs}
          <div className="p-5"><EmptyState title="Tidak memiliki akses" description="Anda memerlukan izin booking.read untuk melihat antrean hewan overdue." /></div>
        </section>
      </WorkspaceShell>
    );
  }
  if (tab === "renewal" && !workspace.capabilities["membership.read"]) {
    return (
      <WorkspaceShell {...workspace} activePath="/followups">
        <PageHeader eyebrow="Retensi pelanggan" title="Follow-up & perpanjangan" description="Pelanggan yang perlu dihubungi dan membership yang perlu diperpanjang." />
        <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
          {tabs}
          <div className="p-5"><EmptyState title="Tidak memiliki akses" description="Anda memerlukan izin membership.read untuk melihat antrean perpanjangan membership." /></div>
        </section>
      </WorkspaceShell>
    );
  }

  if (tab === "overdue") {
    const branchId = params.branch && UUID.test(params.branch) ? params.branch : null;
    const filter: OverdueFilter = OVERDUE_FILTERS.some((f) => f.value === params.filter) ? (params.filter as OverdueFilter) : "default";
    const [queue, hasFullBranchAccessResult] = await Promise.all([
      loadOverdueQueue(workspace.supabase, { branchId, search, filter, page, pageSize: 25 }),
      workspace.supabase.schema("app").rpc("has_permission", { perm: "branches.all" }),
    ]);
    const hasFullBranchAccess = hasFullBranchAccessResult.data === true;
    const totalPages = Math.max(1, Math.ceil(queue.totalGroups / queue.pageSize));

    return (
      <WorkspaceShell {...workspace} activePath="/followups">
        <PageHeader eyebrow="Retensi pelanggan" title="Follow-up & perpanjangan" description="Pelanggan yang perlu dihubungi dan membership yang perlu diperpanjang." />
        <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
          {tabs}
          <div className="space-y-4 p-5">
            <FollowupSettingsPanel settings={settings} canManage={canManageSettings} />
            <form action="/followups" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="tab" value="overdue" />
              <input type="hidden" name="filter" value={filter === "default" ? "" : filter} />
              <input name="search" defaultValue={search ?? ""} placeholder="Cari pelanggan atau hewan" className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm" />
              <select name="branch" defaultValue={branchId ?? ""} className="h-10 rounded-xl border border-slate-200 px-2 text-sm">
                <option value="">Semua cabang yang bisa diakses</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button className="h-10 rounded-xl bg-slate-800 px-4 text-xs font-bold text-white">Terapkan</button>
            </form>
            <div className="flex flex-wrap gap-1">
              {OVERDUE_FILTERS.map((f) => (
                <Link key={f.value} href={buildHref(params, { filter: f.value === "default" ? undefined : f.value, page: undefined })} className={`rounded-full px-3 py-1.5 text-xs font-bold ${filter === f.value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>{f.label}</Link>
              ))}
            </div>
          </div>
          <OverdueQueueList groups={queue.groups} thresholdDays={queue.thresholdDays} businessName={workspace.activeOrganization.name} followupTemplate={settings.followupTemplate} hasFullBranchAccess={hasFullBranchAccess} />
          <div className="flex items-center justify-between border-t border-slate-100 p-4 text-xs text-slate-500">
            <span>{queue.totalGroups} pelanggan · halaman {queue.page}/{totalPages}</span>
            <div className="flex gap-2">
              {queue.page > 1 ? <Link href={buildHref(params, { page: String(queue.page - 1) })} className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold text-slate-700">Sebelumnya</Link> : null}
              {queue.page < totalPages ? <Link href={buildHref(params, { page: String(queue.page + 1) })} className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold text-slate-700">Berikutnya</Link> : null}
            </div>
          </div>
        </section>
      </WorkspaceShell>
    );
  }

  const view: RenewalView = RENEWAL_VIEWS.some((v) => v.value === params.view) ? (params.view as RenewalView) : "actionable";
  const includeTokens = params.tokens === "1";
  const queue = await loadRenewalQueue(workspace.supabase, { view, search, includeTokens, page, pageSize: 25 });
  const totalPages = Math.max(1, Math.ceil(queue.totalGroups / queue.pageSize));

  return (
    <WorkspaceShell {...workspace} activePath="/followups">
      <PageHeader eyebrow="Retensi pelanggan" title="Follow-up & perpanjangan" description="Pelanggan yang perlu dihubungi dan membership yang perlu diperpanjang." />
      <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
        {tabs}
        <div className="space-y-4 p-5">
          <FollowupSettingsPanel settings={settings} canManage={canManageSettings} />
          <form action="/followups" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="tab" value="renewal" />
            <input type="hidden" name="view" value={view === "actionable" ? "" : view} />
            <input name="search" defaultValue={search ?? ""} placeholder="Cari pelanggan, hewan, atau paket" className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm" />
            <label className="flex items-center gap-1 text-xs font-semibold text-slate-600">
              <input type="checkbox" name="tokens" value="1" defaultChecked={includeTokens} className="h-4 w-4" /> Tampilkan token sekali pakai
            </label>
            <button className="h-10 rounded-xl bg-slate-800 px-4 text-xs font-bold text-white">Terapkan</button>
          </form>
          <div className="flex flex-wrap gap-1">
            {RENEWAL_VIEWS.map((v) => (
              <Link key={v.value} href={buildHref(params, { view: v.value === "actionable" ? undefined : v.value, page: undefined })} className={`rounded-full px-3 py-1.5 text-xs font-bold ${view === v.value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>{v.label}</Link>
            ))}
          </div>
        </div>
        <RenewalQueueList groups={queue.groups} businessName={workspace.activeOrganization.name} renewalTemplate={settings.renewalTemplate} returnTo={currentPath} />
        <div className="flex items-center justify-between border-t border-slate-100 p-4 text-xs text-slate-500">
          <span>{queue.totalGroups} pelanggan · halaman {queue.page}/{totalPages}</span>
          <div className="flex gap-2">
            {queue.page > 1 ? <Link href={buildHref(params, { page: String(queue.page - 1) })} className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold text-slate-700">Sebelumnya</Link> : null}
            {queue.page < totalPages ? <Link href={buildHref(params, { page: String(queue.page + 1) })} className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold text-slate-700">Berikutnya</Link> : null}
          </div>
        </div>
      </section>
    </WorkspaceShell>
  );
}
