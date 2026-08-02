/** Owner report route for the HomePaw pilot. */
import { PageHeader, StatCard } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadReportWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Laporan" };

export default async function ReportsPage() {
  const workspace = await requireActiveWorkspace(); const data = await loadReportWorkspace(workspace.supabase, workspace.activeOrganization.id);
  return <WorkspaceShell {...workspace} activePath="/reports"><PageHeader eyebrow="Bulan berjalan" title="Laporan pemilik" description="Gambaran ringkas booking, pemasukan, pengeluaran, dan metode pembayaran bulan ini." />
    <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Pendapatan" value={formatRupiah(data.revenue)} helper="Pembayaran berhasil bulan ini." tone="success" /><StatCard label="Pengeluaran" value={formatRupiah(data.expense)} helper="Biaya operasional bulan ini." tone="warning" /><StatCard label="Kas bersih" value={formatRupiah(data.net)} helper="Pendapatan dikurangi pengeluaran tercatat." /><StatCard label="Penyelesaian" value={`${data.completionRate}%`} helper={`${data.completed} selesai dari ${data.totalBookings} booking.`} /></div>
    <div className="mt-7 grid gap-6 lg:grid-cols-2"><section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-bold">Kualitas booking</h2><div className="mt-5 grid grid-cols-3 gap-3 text-center"><div className="rounded-xl bg-slate-50 p-4"><p className="text-2xl font-bold">{data.totalBookings}</p><p className="mt-1 text-xs text-slate-500">Total</p></div><div className="rounded-xl bg-emerald-50 p-4"><p className="text-2xl font-bold text-emerald-700">{data.completed}</p><p className="mt-1 text-xs text-emerald-700">Selesai</p></div><div className="rounded-xl bg-rose-50 p-4"><p className="text-2xl font-bold text-rose-700">{data.canceled}</p><p className="mt-1 text-xs text-rose-700">Batal/no-show</p></div></div></section><section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-bold">Metode pembayaran</h2><div className="mt-5 space-y-3">{data.methodTotals.map((item) => <div key={item.method} className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"><span className="text-sm font-semibold capitalize">{item.method.replaceAll("_", " ")}</span><span className="font-bold">{formatRupiah(item.total)}</span></div>)}</div></section></div>
  </WorkspaceShell>;
}
