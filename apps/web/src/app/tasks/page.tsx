/** Task board route for the HomePaw pilot. */
import { updateTaskStatusAction } from "@/app/pilot-actions";
import { ActionSubmitButton } from "@/components/action-submit-button";
import { TaskForm } from "@/components/pilot-forms";
import { EmptyState, PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadTaskWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Tugas" };

export default async function TasksPage() {
  const workspace = await requireActiveWorkspace(); const data = await loadTaskWorkspace(workspace.supabase, workspace.activeOrganization.id);
  return <WorkspaceShell {...workspace} activePath="/tasks"><PageHeader eyebrow="Koordinasi tim" title="Tugas" description="Follow-up pelanggan, persiapan alat, dan pekerjaan operasional dalam satu antrean." />
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Tugas baru</h2><div className="mt-5"><TaskForm branches={data.branches} /></div></section>
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 p-5"><h2 className="font-bold">Daftar tugas</h2></div><div className="divide-y divide-slate-100">{data.tasks.length === 0 ? <div className="p-5"><EmptyState title="Semua beres" description="Belum ada tugas aktif." /></div> : data.tasks.map((task) => <article key={task.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{task.title}</h3><StatusBadge status={task.status} /><span className="text-[11px] font-bold uppercase text-slate-400">{task.priority}</span></div><p className="mt-1 text-xs text-slate-500">{task.branchName}{task.dueAt ? ` · tenggat ${new Date(task.dueAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}` : ""}</p></div><form action={updateTaskStatusAction} className="flex gap-2"><input type="hidden" name="taskId" value={task.id} />{task.status !== "in_progress" && task.status !== "done" ? <ActionSubmitButton name="status" value="in_progress" pendingLabel="Memulai…" className="rounded-lg border px-3 py-2 text-xs font-bold disabled:cursor-wait disabled:opacity-60">Mulai</ActionSubmitButton> : null}{task.status !== "done" ? <ActionSubmitButton name="status" value="done" pendingLabel="Menyimpan…" className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60">Selesai</ActionSubmitButton> : null}</form></article>)}</div></section>
  </WorkspaceShell>;
}
