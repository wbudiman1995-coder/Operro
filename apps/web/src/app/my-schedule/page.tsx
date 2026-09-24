/**
 * A staff member's own assigned grooming jobs, for the HomePaw pilot.
 *
 * Gives each groomer only their assigned jobs, dispatch controls, private evidence capture,
 * and the minimal state changes needed in the field.
 */
import { setDispatchStageAction, updatePetJobStatusAction } from "@/app/pilot-actions";
import { ActionSubmitButton } from "@/components/action-submit-button";
import { AttendanceCheckinForm } from "@/components/attendance-checkin-form";
import { buildWhatsAppUrl } from "@/components/customer-360";
import { GroomingEvidenceForm, GroomingEvidenceGallery } from "@/components/grooming-evidence-form";
import { StylingReferenceGallery } from "@/components/styling-references";
import { EmptyState, PageHeader, StatusBadge } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadMyScheduleWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Jadwal Saya" };

const nextDispatchStage: Record<string, { value: string; label: string; pendingLabel: string }> = {
  scheduled: { value: "en_route", label: "Mulai perjalanan", pendingLabel: "Memulai…" },
  en_route: { value: "arrived", label: "Tandai sudah tiba", pendingLabel: "Menyimpan…" },
  arrived: { value: "in_service", label: "Mulai layanan", pendingLabel: "Memulai…" },
};

export default async function MySchedulePage() {
  const workspace = await requireActiveWorkspace();
  const jobs = await loadMyScheduleWorkspace(workspace.supabase, workspace.activeOrganization.id, workspace.userId);
  return <WorkspaceShell {...workspace} activePath="/my-schedule"><PageHeader eyebrow="Groomer" title="Jadwal saya" description="Hewan yang ditugaskan ke Anda, belum selesai, 8 hari ke depan." />
    <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {jobs.length === 0 ? <EmptyState title="Tidak ada pekerjaan tertunda" description="Semua hewan yang ditugaskan ke Anda sudah selesai, atau belum ada yang ditugaskan." /> : jobs.map((job) => (
        <article key={job.groomingJobPetId} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div><p className="font-bold">{job.petName}</p><p className="mt-1 text-xs text-slate-500">{job.customerName}</p></div>
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-2 text-xs text-slate-500">{job.startsAt ? new Date(job.startsAt).toLocaleString("id-ID", { dateStyle: "full", timeStyle: "short" }) : "Waktu belum ditentukan"}</p>
          <p className="mt-2 text-sm font-semibold text-emerald-700">{job.services.length > 0 ? job.services.join(", ") : "Belum ada layanan"}</p>
          {job.attendance ? <div className={`mt-3 rounded-xl border px-3 py-2 text-xs font-semibold ${job.attendance.classification === "late" && !job.attendance.waived ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}><p>{job.attendance.classification === "late" ? `Terlambat ${job.attendance.lateMinutes} menit${job.attendance.waived ? " · di-waive" : ""}` : "Hadir tepat waktu"}</p><p className="mt-1 text-[10px] font-normal">Check-in {new Date(job.attendance.checkedInAt).toLocaleString("id-ID")}</p></div> : <AttendanceCheckinForm bookingId={job.bookingId} resourceId={job.resourceId} />}
          {job.fulfillmentMode === "home" ? (() => {
            const whatsappUrl = buildWhatsAppUrl(job.customerPhone, `Halo ${job.customerName}, saya dari tim grooming Operro untuk booking ${job.petName}.`);
            const nextStage = nextDispatchStage[job.dispatchStage ?? "scheduled"];
            return <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold text-emerald-900">Kunjungan rumah</p>
                <StatusBadge status={job.dispatchStage ?? "scheduled"} />
              </div>
              {job.address ? <>
                <p className="mt-2 break-words text-xs leading-5 text-slate-600">{job.address.formattedLine}</p>
                {job.address.landmark ? <p className="mt-1 text-[11px] text-slate-500">Patokan: {job.address.landmark}</p> : null}
                {job.address.accessNotes ? <p className="mt-1 text-[11px] text-slate-500">Akses: {job.address.accessNotes}</p> : null}
              </> : <p className="mt-2 text-xs font-semibold text-amber-700">Alamat kunjungan tidak tersedia.</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {job.customerPhone ? <a href={`tel:${job.customerPhone}`} className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-bold text-emerald-800">Telepon</a> : null}
                {whatsappUrl ? <a href={whatsappUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-bold text-emerald-800">WhatsApp</a> : null}
                {job.address ? <a href={job.address.mapsUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-bold text-emerald-800">Buka Maps</a> : null}
              </div>
              {nextStage ? <form action={setDispatchStageAction} className="mt-3">
                <input type="hidden" name="bookingId" value={job.bookingId} />
                <ActionSubmitButton name="stage" value={nextStage.value} pendingLabel={nextStage.pendingLabel} className="w-full rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60">{nextStage.label}</ActionSubmitButton>
              </form> : null}
            </div>;
          })() : null}
          <GroomingEvidenceGallery evidence={job.evidence} />
          <StylingReferenceGallery photos={job.stylingReferences} petNames={{[job.stylingReferences[0]?.petId??""]:job.petName}} compact />
          <GroomingEvidenceForm bookingId={job.bookingId} petJobId={job.groomingJobPetId} />
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
