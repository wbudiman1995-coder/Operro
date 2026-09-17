/**
 * A staff member's own assigned grooming jobs, for the HomePaw pilot.
 *
 * Narrower than /operations on purpose: no photo capture (attachments exist in the schema
 * for this, but wiring Storage upload is separate work) and no SOP checklist here — just
 * "what's mine, mark it done."
 */
import { updatePetJobStatusAction } from "@/app/pilot-actions";
import { ActionSubmitButton } from "@/components/action-submit-button";
import { EmptyState, PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadMyScheduleWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Jadwal Saya" };

export default async function MySchedulePage() {
  const workspace = await requireActiveWorkspace();
  const jobs = await loadMyScheduleWorkspace(workspace.supabase, workspace.activeOrganization.id, workspace.userId);
  return <WorkspaceShell {...workspace} activePath="/my-schedule"><PageHeader eyebrow="Groomer" title="Jadwal saya" description="Hewan yang ditugaskan ke Anda, belum selesai, 8 hari ke depan." />
    <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {jobs.length === 0 ? <EmptyState title="Tidak ada pekerjaan tertunda" description="Semua hewan yang ditugaskan ke Anda sudah selesai, atau belum ada yang ditugaskan." /> : jobs.map((job) => (
        <article key={job.groomingJobPetId} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div><p className="font-bold">{job.petName}</p><p className="mt-1 text-xs text-slate-500">{job.customerName}</p></div>
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-2 text-xs text-slate-500">{job.startsAt ? new Date(job.startsAt).toLocaleString("id-ID", { dateStyle: "full", timeStyle: "short" }) : "Waktu belum ditentukan"}</p>
          <p className="mt-2 text-sm font-semibold text-emerald-700">{job.services.length > 0 ? job.services.join(", ") : "Belum ada layanan"}</p>
          <form action={updatePetJobStatusAction} className="mt-4 flex gap-2">
            <input type="hidden" name="petJobId" value={job.groomingJobPetId} />
            {job.status === "pending" ? <ActionSubmitButton name="status" value="in_progress" pendingLabel="Memulai…" className="rounded-lg border px-3 py-2 text-xs font-bold disabled:cursor-wait disabled:opacity-60">Mulai</ActionSubmitButton> : null}
            {job.status === "in_progress" ? <ActionSubmitButton name="status" value="complete" pendingLabel="Menyimpan…" className="w-full rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60">Tandai selesai</ActionSubmitButton> : null}
          </form>
        </article>
      ))}
    </section>
  </WorkspaceShell>;
}
