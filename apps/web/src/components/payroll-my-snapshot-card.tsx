/**
 * A groomer's own published payroll snapshot ("Gaji saya"), mirroring HomePaw's
 * groomer-facing renderMyPay() card. Server component -- purely a display of what
 * app.get_my_payroll_snapshot() returns; no calculation happens here.
 */
import { formatRupiah } from "@/lib/pilot-data";
import type { MyPayrollSnapshot } from "@/lib/payroll-data";

const LINES: Array<[keyof MyPayrollSnapshot["breakdown"], string]> = [
  ["basic", "Gaji pokok"], ["weekly", "Gaji mingguan"], ["noLate", "Bonus no-late"], ["noSick", "Bonus no-sakit"],
  ["styling", "Komisi styling"], ["botak", "Insentif Botak"], ["transport", "Bagi hasil transport"],
  ["perDog", "Basic Grooming per dog"], ["daily", "Uang harian"],
];

export function PayrollMySnapshotCard({ snapshot, membershipId }: { snapshot: MyPayrollSnapshot | null; membershipId: string }) {
  if (!snapshot) return null;
  const paid = snapshot.status === "paid";
  const rows = LINES.filter(([key]) => Number(snapshot.breakdown[key]) > 0);
  return (
    <section className={`mb-6 rounded-2xl border-l-4 bg-white p-4 shadow-sm ${paid ? "border-emerald-500" : "border-amber-400"}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-700">Gaji saya</p>
        <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${paid ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
          {paid ? "DIBAYAR" : "BERJALAN"}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        {new Date(snapshot.periodStart).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}
        {" — "}
        {new Date(snapshot.periodEnd).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}
      </p>
      <div className="mt-2 divide-y divide-slate-100">
        {rows.map(([key, label]) => (
          <div key={key} className="flex justify-between py-1.5 text-xs"><span>{label}</span><strong>{formatRupiah(Number(snapshot.breakdown[key]))}</strong></div>
        ))}
        {snapshot.customRows.filter((r) => r.amount > 0).map((row, i) => (
          <div key={i} className="flex justify-between py-1.5 text-xs"><span>{row.label || "Tambahan"}</span><strong>{formatRupiah(row.amount)}</strong></div>
        ))}
        {rows.length === 0 && snapshot.customRows.length === 0 ? <p className="py-1.5 text-xs text-slate-500">Belum ada komponen gaji cycle ini.</p> : null}
      </div>
      <div className="mt-2 flex items-center justify-between border-t-2 border-slate-100 pt-2.5">
        <span className="text-sm font-bold">Total</span>
        <span className="text-lg font-bold text-emerald-700">{formatRupiah(snapshot.total)}</span>
      </div>
      <p className="mt-2 text-[10px] text-slate-400">Angka dari admin, dihitung dari invoice{" · "}update {new Date(snapshot.publishedAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</p>
      <a href={`/payroll/export?format=pdf&membershipId=${membershipId}&anchor=${snapshot.periodStart}`} className="mt-2 inline-block text-[11px] font-bold text-sky-700">Unduh payslip PDF</a>
    </section>
  );
}
