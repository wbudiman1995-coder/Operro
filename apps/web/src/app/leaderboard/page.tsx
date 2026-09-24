/**
 * Groomer leaderboard for the HomePaw pilot.
 *
 * Revenue-per-groomer is deliberately not shown — see loadLeaderboardWorkspace's own
 * comment for why. Dogs groomed and commission earned are both cleanly attributable.
 */
import Link from "next/link";

import { EmptyState, PageHeader, StatCard } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadLeaderboardWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Leaderboard" };

function cycle(month?: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? ""); const now = new Date(); const year = match ? Number(match[1]) : now.getFullYear(); const index = match ? Number(match[2]) - 1 : now.getMonth();
  const start = new Date(Date.UTC(year, index, 1)); const end = new Date(Date.UTC(year, index + 1, 1)); const previous = new Date(Date.UTC(year, index - 1, 1)); const next = new Date(Date.UTC(year, index + 1, 1));
  const key = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start: start.toISOString(), end: end.toISOString(), label: start.toLocaleDateString("id-ID", { month: "long", year: "numeric", timeZone: "UTC" }), previous: key(previous), next: key(next) };
}

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const period = cycle((await searchParams).month);
  const rows = await loadLeaderboardWorkspace(workspace.supabase, workspace.activeOrganization.id, period.start, period.end);
  const totalPets = rows.reduce((sum, row) => sum + row.dogsGroomed, 0); const complaints = rows.reduce((sum, row) => sum + row.complaints, 0); const documented = rows.reduce((sum, row) => sum + row.documentedVisits, 0);

  return <WorkspaceShell {...workspace} activePath="/leaderboard"><PageHeader eyebrow={period.label} title="Kinerja groomer" description="Aktivitas, retensi, durasi aktual, dokumentasi, komisi, dan keluhan yang dapat diatribusikan." />
    <div className="mt-6 flex items-center gap-2"><Link href={`/leaderboard?month=${period.previous}`} className="rounded-lg border px-3 py-2 text-xs font-bold">← Sebelumnya</Link><Link href={`/leaderboard?month=${period.next}`} className="rounded-lg border px-3 py-2 text-xs font-bold">Berikutnya →</Link></div>
    <div className="mt-6 grid gap-4 sm:grid-cols-3"><StatCard label="Hewan selesai" value={String(totalPets)} helper="Ditugaskan langsung ke groomer." /><StatCard label="Visit terdokumentasi" value={String(documented)} helper="Memiliki foto before dan after." tone="success" /><StatCard label="Keluhan" value={String(complaints)} helper="Task berlabel complaint pada cycle ini." tone={complaints ? "warning" : "success"} /></div>
    <section className="mt-7 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      {rows.length === 0 ? (
        <div className="p-6"><EmptyState title="Belum ada groomer aktif" description="Groomer dengan booking selesai bulan ini akan muncul di sini." /></div>
      ) : (
        <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead className="bg-slate-50/80 text-left text-xs font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">#</th><th className="px-5 py-3">Groomer</th><th className="px-5 py-3">Hewan</th><th className="px-5 py-3">Retensi</th><th className="px-5 py-3">Durasi aktual</th><th className="px-5 py-3">Dokumentasi</th><th className="px-5 py-3">Keluhan</th><th className="px-5 py-3">Komisi</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.map((row, index) => (
            <tr key={row.resourceId}>
              <td className="whitespace-nowrap px-5 py-4 text-lg">{index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : index + 1}</td>
              <td className="whitespace-nowrap px-5 py-4 font-bold text-slate-900"><Link href={`/leaderboard/${row.resourceId}?month=${period.start.slice(0, 7)}`} className="text-sky-800 hover:underline">{row.name}</Link></td>
              <td className="whitespace-nowrap px-5 py-4 text-slate-600">{row.dogsGroomed}</td>
              <td className="whitespace-nowrap px-5 py-4 text-slate-600">{row.retentionRate}% <span className="text-xs text-slate-400">({row.retainedCustomers}/{row.customerCount})</span></td>
              <td className="whitespace-nowrap px-5 py-4 text-slate-600">{row.averageDurationMinutes === null ? "Belum ada data" : `${row.averageDurationMinutes} menit`}</td>
              <td className="whitespace-nowrap px-5 py-4 text-slate-600">{row.documentationRate}% <span className="text-xs text-slate-400">({row.documentedVisits})</span></td>
              <td className={`whitespace-nowrap px-5 py-4 font-bold ${row.complaints ? "text-rose-700" : "text-emerald-700"}`}>{row.complaints}</td>
              <td className="whitespace-nowrap px-5 py-4 text-slate-600">{formatRupiah(row.commissionTotal)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  </WorkspaceShell>;
}
