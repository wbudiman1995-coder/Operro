import Link from "next/link";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Riwayat groomer | Operro" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function row(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return row(value[0]);
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export default async function GroomerHistoryPage({ params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params;
  const workspace = await requireActiveWorkspace();
  const org = workspace.activeOrganization.id;
  if (!UUID.test(resourceId) || !workspace.capabilities["booking.read"]) return <WorkspaceShell {...workspace} activePath="/catalog"><PageHeader eyebrow="Tim groomer" title="Riwayat booking" description="Booking lama tetap tersimpan setelah groomer diarsipkan." /><RestrictedNotice title="Riwayat tidak dapat dibuka" description="Gunakan tautan dari groomer yang diarsipkan dan pastikan peran Anda memiliki izin booking.read." /></WorkspaceShell>;

  const [resourceResult, jobsResult] = await Promise.all([
    workspace.supabase.from("resources").select("id,name,deleted_at").eq("organization_id", org).eq("id", resourceId).eq("kind", "staff").maybeSingle(),
    workspace.supabase.from("grooming_job_pets").select("grooming_job_id,status,pets(name),grooming_jobs!inner(booking_id,bookings!inner(id,starts_at,status,customers(display_name)))").eq("organization_id", org).eq("assigned_resource_id", resourceId).is("deleted_at", null).limit(200),
  ]);
  const resource = resourceResult.data;
  const entries = (jobsResult.data ?? []).flatMap((item) => {
    const source = item as Record<string, unknown>;
    const job = row(source.grooming_jobs); const booking = row(job?.bookings); const customer = row(booking?.customers); const pet = row(source.pets);
    if (!booking || typeof booking.id !== "string" || typeof booking.starts_at !== "string") return [];
    return [{ id: `${booking.id}:${String(source.grooming_job_id ?? "")}`, bookingId: booking.id, startsAt: booking.starts_at, bookingStatus: String(booking.status ?? "unknown"), petStatus: String(source.status ?? "unknown"), customerName: String(customer?.display_name ?? "Pelanggan"), petName: String(pet?.name ?? "Hewan") }];
  }).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

  return <WorkspaceShell {...workspace} activePath="/catalog"><PageHeader eyebrow="Tim groomer" title={resource ? `Riwayat booking · ${resource.name}` : "Riwayat booking groomer"} description="Riwayat tidak berubah saat groomer diarsipkan. Halaman ini bersifat baca-saja." />
    <div className="mt-5"><Link href="/catalog#daftar-groomer" className="text-xs font-bold text-emerald-800 underline">← Kembali ke tim groomer</Link></div>
    {resourceResult.error || !resource ? <RestrictedNotice title="Groomer tidak ditemukan" description="Groomer ini tidak tersedia pada workspace aktif." /> : jobsResult.error ? <RestrictedNotice title="Riwayat belum dapat dimuat" description="Muat ulang halaman atau periksa izin booking.read Anda." /> : <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Booking historis ({entries.length})</h2><p className="mt-1 text-xs text-slate-500">Termasuk booking selesai, dibatalkan, dan booking lama yang pernah ditugaskan kepada groomer ini.</p></div>{entries.length === 0 ? <p className="p-5 text-sm text-slate-500">Belum ada assignment booking yang tersimpan untuk groomer ini.</p> : <div className="divide-y">{entries.map((entry) => <article key={entry.id} className="flex flex-wrap items-center justify-between gap-3 p-5"><div><Link href={`/schedule?booking=${entry.bookingId}`} className="font-bold text-emerald-800 hover:underline">{entry.customerName} · {entry.petName}</Link><p className="mt-1 text-xs text-slate-500">{new Date(entry.startsAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</p></div><div className="text-right text-xs"><p className="font-semibold">Booking: {entry.bookingStatus}</p><p className="mt-1 text-slate-500">Status hewan: {entry.petStatus}</p></div></article>)}</div>}</section>}
  </WorkspaceShell>;
}
