/**
 * Groomer leaderboard for the HomePaw pilot.
 *
 * Revenue-per-groomer is deliberately not shown — see loadLeaderboardWorkspace's own
 * comment for why. Dogs groomed and commission earned are both cleanly attributable.
 */
import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadLeaderboardWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Leaderboard" };

export default async function LeaderboardPage() {
  const workspace = await requireActiveWorkspace();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);
  const label = new Date(start).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
  const rows = await loadLeaderboardWorkspace(workspace.supabase, workspace.activeOrganization.id, start, end);

  return <WorkspaceShell {...workspace} activePath="/leaderboard"><PageHeader eyebrow={label} title="Leaderboard groomer" description="Diurutkan dari jumlah hewan yang diselesaikan bulan ini." />
    <section className="mt-7 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      {rows.length === 0 ? (
        <div className="p-6"><EmptyState title="Belum ada groomer aktif" description="Groomer dengan booking selesai bulan ini akan muncul di sini." /></div>
      ) : (
        <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead className="bg-slate-50/80 text-left text-xs font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-6 py-3">#</th><th className="px-6 py-3">Groomer</th><th className="px-6 py-3">Hewan selesai</th><th className="px-6 py-3">Komisi</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.map((row, index) => (
            <tr key={row.resourceId}>
              <td className="whitespace-nowrap px-6 py-4 text-lg">{index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : index + 1}</td>
              <td className="whitespace-nowrap px-6 py-4 font-bold text-slate-900">{row.name}</td>
              <td className="whitespace-nowrap px-6 py-4 text-slate-600">{row.dogsGroomed}</td>
              <td className="whitespace-nowrap px-6 py-4 text-slate-600">{formatRupiah(row.commissionTotal)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  </WorkspaceShell>;
}
