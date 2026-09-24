import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState, PageHeader, StatCard } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadGroomerPerformanceDetail } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Detail kinerja groomer" };

function cycle(month?: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? ""); const now = new Date(); const year = match ? Number(match[1]) : now.getFullYear(); const index = match ? Number(match[2]) - 1 : now.getMonth(); const start = new Date(Date.UTC(year, index, 1)); const end = new Date(Date.UTC(year, index + 1, 1));
  return { start: start.toISOString(), end: end.toISOString(), key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, label: start.toLocaleDateString("id-ID", { month: "long", year: "numeric", timeZone: "UTC" }) };
}

export default async function GroomerPerformancePage({ params, searchParams }: { params: Promise<{ resourceId: string }>; searchParams: Promise<{ month?: string }> }) {
  const workspace = await requireActiveWorkspace(); const { resourceId } = await params; const period = cycle((await searchParams).month);
  const data = await loadGroomerPerformanceDetail(workspace.supabase, workspace.activeOrganization.id, resourceId, period.start, period.end); if (!data) notFound();
  return <WorkspaceShell {...workspace} activePath="/leaderboard"><PageHeader eyebrow={period.label} title={data.summary.name} description="Drill-down visit dan bukti yang membentuk metrik kinerja." action={<Link href={`/leaderboard?month=${period.key}`} className="rounded-xl border px-4 py-2 text-sm font-bold">Kembali</Link>} />
    <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Hewan selesai" value={String(data.summary.dogsGroomed)} helper={`${data.summary.customerCount} pelanggan unik.`} /><StatCard label="Retensi" value={`${data.summary.retentionRate}%`} helper={`${data.summary.retainedCustomers} pelanggan kembali.`} tone="success" /><StatCard label="Dokumentasi" value={`${data.summary.documentationRate}%`} helper="Foto before + after." /><StatCard label="Komisi" value={formatRupiah(data.summary.commissionTotal)} helper={`${data.summary.complaints} keluhan pada cycle.`} tone={data.summary.complaints ? "warning" : "success"} /></div>
    <section className="mt-7 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Visit yang dihitung</h2></div>{data.visits.length === 0 ? <div className="p-6"><EmptyState title="Belum ada visit selesai" description="Visit selesai pada cycle ini akan muncul di sini." /></div> : <div className="divide-y">{data.visits.map((visit) => <article key={visit.bookingId} className="flex flex-wrap items-center justify-between gap-4 p-5"><div><Link href={`/operations?booking=${visit.bookingId}`} className="font-bold text-sky-800 hover:underline">{visit.customerName}</Link><p className="mt-1 text-xs text-slate-500">{new Date(visit.startsAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })} · {visit.petNames.join(", ")}</p></div><div className="text-right"><p className="text-sm font-bold">{visit.actualDurationMinutes === null ? "Durasi belum terekam" : `${visit.actualDurationMinutes} menit`}</p><p className={`mt-1 text-xs font-semibold ${visit.documented ? "text-emerald-700" : "text-amber-700"}`}>{visit.documented ? "Before + after lengkap" : "Dokumentasi belum lengkap"} · {visit.evidenceCount} file</p></div></article>)}</div>}</section>
  </WorkspaceShell>;
}
