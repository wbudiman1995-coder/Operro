/**
 * Overdue-followup route for the HomePaw pilot.
 *
 * "Last groomed" comes from grooming_job_pets (pet-level), not bookings.pet_id — see
 * loadFollowupWorkspace's own comment for why the latter is non-authoritative here.
 */
import { EmptyState, PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadFollowupWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Follow-up Pelanggan" };

function waLink(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const international = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  return `https://wa.me/${international}`;
}

export default async function FollowupsPage() {
  const workspace = await requireActiveWorkspace();
  const groups = await loadFollowupWorkspace(workspace.supabase, workspace.activeOrganization.id);

  return <WorkspaceShell {...workspace} activePath="/followups"><PageHeader eyebrow="Retensi pelanggan" title="Pelanggan yang perlu dihubungi" description="Hewan yang sudah lebih dari 30 hari sejak terakhir grooming." />
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
      {groups.length === 0 ? (
        <div className="p-6"><EmptyState title="Tidak ada yang overdue" description="Semua pelanggan aktif sudah digroom dalam 30 hari terakhir." /></div>
      ) : (
        <ul className="divide-y">{groups.map((group) => {
          const link = group.phone ? waLink(group.phone) : null;
          return (
            <li key={group.customerId} className="flex items-center justify-between gap-4 p-5">
              <div className="min-w-0">
                <p className="font-bold text-slate-900">{group.customerName}</p>
                <p className="mt-0.5 truncate text-xs text-slate-500">{group.pets.map((p) => `${p.petName} (${p.daysSince} hari)`).join(", ")}</p>
              </div>
              {link ? <a href={link} target="_blank" rel="noreferrer" className="shrink-0 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">Buka WhatsApp</a> : <span className="shrink-0 text-xs text-slate-400">Tidak ada nomor</span>}
            </li>
          );
        })}</ul>
      )}
    </section>
  </WorkspaceShell>;
}
