import Link from "next/link";

import { groupCashByCurrency, type CashPeriod, type CashPositionRow } from "@/lib/cash-position";

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("id-ID", { style: "currency", currency, maximumFractionDigits: currency === "IDR" ? 0 : 2 }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString("id-ID")}`;
  }
}

/**
 * Read-only cash position. Currencies are never added together; a period with no rows says so instead of
 * showing zeros; pending/failed payments are listed as excluded. Not an accounting ledger.
 */
export function CashPositionPanel({ period, rows, timeZone, error, exportHref }: {
  period: CashPeriod; rows: CashPositionRow[] | null; timeZone: string; error?: string | null; exportHref?: string;
}) {
  const totals = rows ? groupCashByCurrency(rows) : [];
  return <section aria-labelledby="cash-position-title" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="cash-position-title" className="font-bold">Posisi kas (laporan baca-saja)</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">Dihitung dari pembayaran berhasil, pengembalian dana berhasil, dan pengeluaran pada periode {period.from} s.d. {period.to} (zona waktu {timeZone}). Setiap mata uang dipisah. Ini bukan buku besar akuntansi: tanpa saldo awal, modal, transfer antar rekening, pajak, atau payroll. Saldo awal dan modal yang dideklarasikan ada di <Link href="/finance/register" className="font-bold underline">Register kas</Link> dan sengaja tidak digabung di sini.</p>
      </div>
      {exportHref ? <a href={exportHref} className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">Export Excel (termasuk posisi kas)</a> : null}
    </div>
    <form method="get" className="mt-4 flex flex-wrap items-end gap-3" aria-label="Periode kas">
      <label className="text-[11px] font-semibold text-slate-500">Dari<input type="date" name="from" defaultValue={period.from} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs" /></label>
      <label className="text-[11px] font-semibold text-slate-500">Sampai<input type="date" name="to" defaultValue={period.to} className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-xs" /></label>
      <button type="submit" className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700">Terapkan</button>
    </form>
    {error ? <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-xs font-semibold text-rose-700">{error}</p> : null}
    {rows && rows.length === 0 && !error ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-xs text-slate-500">Tidak ada pembayaran, pengembalian dana, atau pengeluaran pada periode ini.</p> : null}
    {rows && rows.length > 0 ? <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {totals.map((total) => <div key={total.currency} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{total.currency} · selisih periode</p>
          <p className={`mt-1 text-xl font-bold ${total.net < 0 ? "text-rose-700" : "text-slate-900"}`}>{money(total.net, total.currency)}</p>
          <p className="mt-1 text-[11px] text-slate-500">Masuk {money(total.paymentsIn, total.currency)} · Refund {money(total.refundsOut, total.currency)} · Keluar {money(total.expensesOut, total.currency)}</p>
        </div>)}
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-[11px] uppercase text-slate-400"><tr><th className="py-2 pr-3">Bulan</th><th className="pr-3">Mata uang</th><th className="pr-3 text-right">Pembayaran masuk</th><th className="pr-3 text-right">Pengembalian dana</th><th className="pr-3 text-right">Pengeluaran</th><th className="pr-3 text-right">Selisih</th><th className="text-right">Tidak dihitung</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => <tr key={`${row.period}-${row.currency}`}>
              <td className="py-2 pr-3 font-semibold">{row.period}</td><td className="pr-3">{row.currency}</td>
              <td className="pr-3 text-right">{money(row.paymentsIn, row.currency)} <span className="text-slate-400">({row.paymentsCount})</span></td>
              <td className="pr-3 text-right">{money(row.refundsOut, row.currency)} <span className="text-slate-400">({row.refundsCount})</span></td>
              <td className="pr-3 text-right">{money(row.expensesOut, row.currency)} <span className="text-slate-400">({row.expensesCount})</span></td>
              <td className={`pr-3 text-right font-bold ${row.net < 0 ? "text-rose-700" : ""}`}>{money(row.net, row.currency)}</td>
              <td className="text-right text-slate-500">{row.excludedPayments > 0 ? `${row.excludedPayments} pembayaran tertunda/gagal` : "—"}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </> : null}
  </section>;
}
