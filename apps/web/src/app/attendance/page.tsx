import Image from "next/image";
import Link from "next/link";

import { AttendanceSyncForm, AttendanceWaiverForm } from "@/components/attendance-admin-actions";
import { PageHeader, StatCard } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadAttendanceWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Kehadiran" };

function resolveCycle(month?: string) {
  const matched = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  const now = new Date(); const year = matched ? Number(matched[1]) : now.getFullYear(); const monthIndex = matched ? Number(matched[2]) - 1 : now.getMonth();
  const start = new Date(Date.UTC(year, monthIndex, 1)); const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const previous = new Date(Date.UTC(year, monthIndex - 1, 1)); const next = new Date(Date.UTC(year, monthIndex + 1, 1));
  const key = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start: start.toISOString(), end: end.toISOString(), startDate: key(start) + "-01", endDate: key(end) + "-01", label: start.toLocaleDateString("id-ID", { month: "long", year: "numeric", timeZone: "UTC" }), previous: key(previous), next: key(next) };
}

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const workspace = await requireActiveWorkspace(); const params = await searchParams; const cycle = resolveCycle(params.month);
  const header = <PageHeader eyebrow="Tim lapangan" title="Kehadiran" description="Foto, GPS, ketepatan waktu, alasan keterlambatan, waiver, dan ringkasan cycle payroll." />;
  if (!workspace.capabilities["payroll.read"] && !workspace.capabilities["resource.manage"]) return <WorkspaceShell {...workspace} activePath="/attendance">{header}<div className="mt-7"><RestrictedNotice title="Tidak ada izin kehadiran" description="Peran ini memerlukan payroll.read atau resource.manage." /></div></WorkspaceShell>;
  const data = await loadAttendanceWorkspace(workspace.supabase, workspace.activeOrganization.id, cycle.start, cycle.end);
  const totalLate = data.rows.filter((row) => row.classification === "late" && !row.waivedAt).length; const missing = data.rows.filter((row) => row.classification === "missing_photo").length;
  const grouped = new Map<string, typeof data.rows>(); for (const row of data.rows) { const key = new Date(row.scheduledAt).toLocaleDateString("id-ID", { dateStyle: "full" }); grouped.set(key, [...(grouped.get(key) ?? []), row]); }
  return <WorkspaceShell {...workspace} activePath="/attendance">{header}
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Link href={`/attendance?month=${cycle.previous}`} className="rounded-lg border px-3 py-2 text-xs font-bold">← Sebelumnya</Link><span className="px-2 text-sm font-bold capitalize">{cycle.label}</span><Link href={`/attendance?month=${cycle.next}`} className="rounded-lg border px-3 py-2 text-xs font-bold">Berikutnya →</Link></div>{workspace.capabilities["payroll.manage"] ? <AttendanceSyncForm from={cycle.startDate} to={cycle.endDate} /> : null}</div>
    <div className="mt-6 grid gap-4 sm:grid-cols-3"><StatCard label="Check-in" value={String(data.rows.length)} helper="Catatan dalam cycle." /><StatCard label="Terlambat aktif" value={String(totalLate)} helper="Tidak termasuk waiver." tone={totalLate ? "warning" : "success"} /><StatCard label="Foto hilang" value={String(missing)} helper="Booking lampau tanpa check-in foto." tone={missing ? "warning" : "success"} /></div>
    <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Ringkasan groomer</h2></div><div className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-3">{data.summary.map((item) => <div key={item.resourceId} className="bg-white p-5"><p className="font-bold">{item.resourceName}</p><p className="mt-2 text-xs text-slate-500">{item.total} jadwal · {item.onTime} tepat waktu · {item.late} terlambat</p><p className="mt-1 text-xs text-slate-500">{item.missingPhoto} tanpa foto · {item.waived} waiver · {item.lateMinutes} menit terlambat</p></div>)}</div></section>
    <section className="mt-6 space-y-5">{[...grouped.entries()].map(([day, rows]) => <div key={day}><h2 className="mb-2 text-sm font-bold capitalize text-slate-700">{day}</h2><div className="grid gap-3 lg:grid-cols-2">{rows.map((row) => <article key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex gap-3">{row.photoUrl ? <a href={row.photoUrl} target="_blank" rel="noreferrer" className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-slate-100"><Image src={row.photoUrl} alt={`Foto kehadiran ${row.resourceName}`} fill sizes="80px" className="object-cover" /></a> : <div className="grid size-20 shrink-0 place-items-center rounded-xl bg-amber-50 px-2 text-center text-[10px] font-bold text-amber-700">Foto hilang</div>}<div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><p className="font-bold">{row.resourceName}</p><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${row.classification === "on_time" ? "bg-emerald-50 text-emerald-700" : row.waivedAt ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-700"}`}>{row.waivedAt ? "waived" : row.classification.replaceAll("_", " ")}</span></div><p className="mt-1 text-xs text-slate-500">Jadwal {new Date(row.scheduledAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })} · check-in {new Date(row.checkedInAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</p>{row.classification === "late" ? <p className="mt-1 text-xs text-amber-700">{row.lateMinutes} menit · {row.lateReason ?? "Tanpa alasan"}</p> : null}{row.latitude !== null && row.longitude !== null ? <a href={`https://www.google.com/maps/search/?api=1&query=${row.latitude},${row.longitude}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-bold text-sky-700">Buka lokasi GPS</a> : null}</div></div>{workspace.capabilities["payroll.manage"] && row.classification === "late" && !row.waivedAt ? <AttendanceWaiverForm attendanceId={row.id} /> : null}{row.waiverReason ? <p className="mt-2 rounded-lg bg-sky-50 px-2 py-1.5 text-[11px] text-sky-800">Waiver: {row.waiverReason}</p> : null}</article>)}</div></div>)}</section>
  </WorkspaceShell>;
}
