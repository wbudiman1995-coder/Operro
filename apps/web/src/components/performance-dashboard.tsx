/**
 * Function index:
 * - PerformanceDashboard: period selector plus the three capability-scoped performance sections.
 *
 * Read-only. The period selector is a plain GET form/links: the chosen range is only a validated display input
 * (see lib/dashboard-period) and never decides which organization or branch is read.
 */
import Link from "next/link";

import { EmptyState } from "@/components/pilot-ui";
import {
  describeChange, formatMoney, type CardState, type DashboardPerformance, type FinanceCurrency, type OperationsData, type SourceData, type SourceRow,
} from "@/lib/dashboard-performance";
import { formatRatio, RETURN_DEFINITION, type SourceReturn, type SourceReturnRow } from "@/lib/marketing-spend";
import { DASHBOARD_PERIOD_LABELS, DASHBOARD_PERIOD_PRESETS, MAX_DASHBOARD_PERIOD_DAYS, type DashboardPeriod } from "@/lib/dashboard-period";

interface Props {
  period: DashboardPeriod;
  periodError: string | null;
  performance: DashboardPerformance;
  timeZone: string;
  /** finance.manage: shows the link that records marketing spend (the database still decides). */
  canManageSpend?: boolean;
}

const PRESET_LINKS = DASHBOARD_PERIOD_PRESETS.filter((preset) => preset !== "custom");
const sectionClass = "rounded-[14px] border border-[#e4e7ec] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.06)] sm:p-7";

function Unavailable({ title, state }: { title: string; state: Extract<CardState<unknown>, { status: "restricted" | "unavailable" }> }) {
  return (
    <section aria-label={title} className="rounded-[14px] border border-dashed border-slate-300 bg-slate-50 p-5">
      <h3 className="text-sm font-bold text-slate-600">{title}</h3>
      <p className="mt-2 text-sm font-bold text-slate-600">{state.status === "restricted" ? "Tidak tersedia untuk peran ini" : "Data belum dapat dimuat"}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{state.reason}</p>
    </section>
  );
}

function Figure({ label, value, change, tone }: { label: string; value: string; change: string; tone?: "warning" }) {
  return (
    <div className="rounded-[11px] bg-[#f6f7f9] p-4">
      <p className="text-[12px] font-semibold text-[#5b6472]">{label}</p>
      <p className={`mt-1 text-2xl font-bold tracking-[-0.03em] ${tone === "warning" ? "text-amber-700" : "text-[#1a2233]"}`}>{value}</p>
      <p className="mt-1 text-[11px] leading-5 text-[#8a93a3]">{change}</p>
    </div>
  );
}

function Operations({ data }: { data: OperationsData }) {
  const total = Object.values(data.current).reduce((sum, value) => sum + value, 0) + Object.values(data.previous).reduce((sum, value) => sum + value, 0);
  if (total === 0) return <EmptyState title="Belum ada booking pada periode ini" description="Tidak ada booking yang mulai pada periode ini maupun periode pembanding pada cabang yang dapat Anda akses." />;
  const items: Array<{ label: string; key: keyof OperationsData["current"] }> = [
    { label: "Selesai", key: "completed" }, { label: "Terjadwal / berjalan", key: "open" }, { label: "Dibatalkan", key: "canceled" }, { label: "Tidak hadir", key: "noShow" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map(({ label, key }) => <Figure key={key} label={label} value={String(data.current[key])} change={describeChange(data.current[key], data.previous[key]).text} />)}
    </div>
  );
}

function FinanceBlock({ entry, multi }: { entry: FinanceCurrency; multi: boolean }) {
  const money = (value: number) => formatMoney(value, entry.currency);
  const { current, previous, outstanding } = entry;
  return (
    <div>
      {multi ? <h4 className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-[#5b6472]">Mata uang {entry.currency}</h4> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Figure label="Invoice terbit" value={money(current.issuedTotal)} change={`${current.issuedCount} invoice. ${describeChange(current.issuedTotal, previous.issuedTotal, money).text}`} />
        <Figure label="Pembayaran diterima" value={money(current.collectedTotal)} change={`${current.collectedCount} pembayaran. ${describeChange(current.collectedTotal, previous.collectedTotal, money).text}`} />
        <Figure label="Refund" value={money(current.refundedTotal)} change={`${current.refundedCount} refund. ${describeChange(current.refundedTotal, previous.refundedTotal, money).text}`} />
        <Figure
          label="Invoice belum lunas (saat ini)"
          value={money(outstanding.total)}
          change={`${outstanding.count} invoice, ${outstanding.overdue} lewat jatuh tempo. Posisi hari ini, tidak mengikuti periode.`}
          tone={outstanding.overdue > 0 ? "warning" : undefined}
        />
      </div>
      {current.collectedOnVoid > 0 ? <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{current.collectedOnVoid} pembayaran pada periode ini tercatat pada invoice yang sudah dibatalkan. Angka pembayaran tetap menghitungnya; periksa dan selesaikan lewat Keuangan.</p> : null}
    </div>
  );
}

function sourceName(row: SourceRow): string {
  if (row.kind === "missing") return "Tanpa sumber";
  if (row.kind === "other") return `Sumber lain (${row.sourceCount} sumber)`;
  return row.label ?? "Tanpa sumber";
}

function Cell({ current, previous }: { current: number | null; previous: number | null }) {
  if (current === null) return <span title="Perlu izin akses yang tidak dimiliki peran ini" className="text-slate-400">—</span>;
  return <span><strong>{current}</strong> <span className="text-[11px] text-[#8a93a3]">(sebelumnya {previous ?? 0})</span></span>;
}

function Sources({ data }: { data: SourceData }) {
  if (data.rows.length === 0) return <EmptyState title="Belum ada aktivitas sumber pada periode ini" description="Tidak ada pelanggan baru maupun pelanggan dengan booking selesai atau pembayaran pertama pada periode ini maupun pembanding." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-[#e4e7ec] text-[12px] text-[#5b6472]">
            <th scope="col" className="py-2 pr-3 font-semibold">Sumber</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Pelanggan baru</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Booking selesai pertama</th>
            <th scope="col" className="py-2 font-semibold">Pembayaran invoice pertama</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.key} className="border-b border-[#f0f2f5] last:border-0">
              <th scope="row" className="max-w-[16rem] truncate py-2 pr-3 font-semibold text-[#1a2233]">{sourceName(row)}</th>
              <td className="py-2 pr-3"><Cell current={row.current.newCustomers} previous={row.previous.newCustomers} /></td>
              <td className="py-2 pr-3"><Cell current={row.current.firstCompleted} previous={row.previous.firstCompleted} /></td>
              <td className="py-2"><Cell current={row.current.firstPaid} previous={row.previous.firstPaid} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Definition({ children }: { children: React.ReactNode }) {
  return <details className="mt-4 text-xs text-[#5b6472]"><summary className="cursor-pointer font-semibold text-[#0f8a72]">Definisi angka</summary><div className="mt-2 space-y-1 leading-5">{children}</div></details>;
}

function SourceReturnBlock({ state, canManageSpend }: { state: DashboardPerformance["sourceReturn"]; canManageSpend: boolean }) {
  const noSpend = "Belum ada biaya pemasaran tercatat pada periode ini, sehingga ROI per sumber tidak tersedia.";
  if (state.status === "hidden") return null;
  if (state.status !== "ready") {
    return <p role="note" className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">{state.reason} Tabel ini hanya menghitung pelanggan.</p>;
  }
  const data: SourceReturn = state.data;
  const spendRows = data.rows.filter((row) => row.hasSpend);
  if (spendRows.length === 0) {
    return (
      <p role="note" className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
        {noSpend} Tabel ini hanya menghitung pelanggan. {canManageSpend ? <Link href="/finance/marketing" className="font-bold text-[#0f8a72]">Catat biaya pemasaran</Link> : null}
      </p>
    );
  }
  const currencies = [...new Set(data.rows.map((row) => row.currency))].sort((a, b) => (a === "IDR" ? -1 : b === "IDR" ? 1 : a.localeCompare(b)));
  return (
    <div className="mt-5" aria-label="ROI sederhana per sumber">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="text-sm font-bold text-[#1a2233]">ROI sederhana per sumber (pelanggan baru periode ini)</h4>
        <Link href="/finance/marketing" className="text-xs font-bold text-[#0f8a72]">Biaya pemasaran</Link>
      </div>
      {currencies.length > 1 ? <p role="note" className="mb-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">Terdapat lebih dari satu mata uang. Angka ditampilkan per mata uang dan tidak dijumlahkan.</p> : null}
      <div className="space-y-4">
        {currencies.map((currency) => <ReturnTable key={currency} currency={currency} rows={data.rows.filter((row) => row.currency === currency)} />)}
      </div>
      {data.truncated ? <p className="mt-2 text-xs text-slate-500">Hanya {data.rows.length} baris teratas ditampilkan.</p> : null}
      <Definition>{RETURN_DEFINITION.map((line) => <p key={line}>{line}</p>)}</Definition>
    </div>
  );
}

function ReturnTable({ currency, rows }: { currency: string; rows: SourceReturnRow[] }) {
  const money = (value: number) => formatMoney(value, currency);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left text-xs">
        <caption className="pb-1 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">{currency}</caption>
        <thead><tr className="text-slate-500"><th scope="col" className="py-1 pr-3 font-semibold">Sumber</th><th scope="col" className="py-1 pr-3 text-right font-semibold">Biaya</th><th scope="col" className="py-1 pr-3 text-right font-semibold">Pelanggan baru / membayar</th><th scope="col" className="py-1 pr-3 text-right font-semibold">Pendapatan bersih</th><th scope="col" className="py-1 pr-3 text-right font-semibold">Selisih</th><th scope="col" className="py-1 text-right font-semibold">Rasio</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.key}:${row.currency}`} className="border-t border-slate-100">
              <th scope="row" className="py-1.5 pr-3 font-semibold text-slate-800">{row.label}</th>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.hasSpend ? money(row.spend) : "Tidak dicatat"}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.cohortCustomers} / {row.payingCustomers}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{money(row.netRevenue)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{row.hasSpend ? money(row.netResult) : "—"}</td>
              <td className="py-1.5 text-right font-bold tabular-nums">{formatRatio(row.ratio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PerformanceDashboard({ period, periodError, performance, timeZone, canManageSpend = false }: Props) {
  const { operations, finance, sources } = performance;
  const allHidden = [operations, finance, sources].every((state) => state.status === "hidden");
  const financeMulti = finance.status === "ready" && finance.data.currencies.length > 1;

  return (
    <section aria-label="Performa bisnis" className="mt-8 space-y-6">
      <div className={sectionClass}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-[#1a2233]">Performa bisnis</h2>
            <p className="mt-1 text-sm font-semibold text-[#1a2233]">{period.label}</p>
            <p className="text-xs text-[#5b6472]">{period.comparisonLabel}. Tanggal mengikuti zona waktu {timeZone}; kartu “hari ini” di atas tidak mengikuti periode ini.</p>
          </div>
          <nav aria-label="Pilih periode" className="flex flex-wrap gap-2">
            {PRESET_LINKS.map((preset) => (
              <Link
                key={preset}
                href={preset === "today" ? "/dashboard" : `/dashboard?period=${preset}`}
                aria-current={period.preset === preset ? "page" : undefined}
                className={`rounded-full px-3 py-1.5 text-xs font-bold ${period.preset === preset ? "bg-[#0f8a72] text-white" : "bg-[#f0f2f5] text-[#1a2233] hover:bg-[#e4e7ec]"}`}
              >
                {DASHBOARD_PERIOD_LABELS[preset]}
              </Link>
            ))}
          </nav>
        </div>
        <form method="get" action="/dashboard" className="mt-4 flex flex-wrap items-end gap-3 text-xs font-semibold text-[#5b6472]">
          <input type="hidden" name="period" value="custom" />
          <label className="flex flex-col gap-1">Dari
            <input type="date" name="from" required min="2000-01-01" max={period.today} defaultValue={period.preset === "custom" ? period.current.from : undefined} className="h-9 rounded-lg border border-[#d0d5dd] px-2 text-sm text-[#1a2233]" />
          </label>
          <label className="flex flex-col gap-1">Sampai
            <input type="date" name="to" required min="2000-01-01" max={period.today} defaultValue={period.preset === "custom" ? period.current.to : undefined} className="h-9 rounded-lg border border-[#d0d5dd] px-2 text-sm text-[#1a2233]" />
          </label>
          <button type="submit" className="h-9 rounded-lg bg-[#1a2233] px-4 text-xs font-bold text-white">Terapkan rentang</button>
          <span className="text-[11px] font-normal text-[#8a93a3]">Maksimal {MAX_DASHBOARD_PERIOD_DAYS} hari, tidak boleh melewati hari ini.</span>
        </form>
        {periodError ? <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">{periodError}</p> : null}
      </div>

      {allHidden ? <EmptyState title="Kartu performa disembunyikan" description="Pemilik workspace dapat menampilkannya kembali di Pengaturan tampilan dashboard." /> : null}

      {operations.status === "hidden" ? null : operations.status === "ready" ? (
        <div className={sectionClass}>
          <div className="mb-4 flex items-center justify-between gap-3"><h3 className="font-bold text-[#1a2233]">Operasional</h3><Link href="/schedule" className="text-xs font-bold text-[#0f8a72]">Buka jadwal</Link></div>
          <Operations data={operations.data} />
          <Definition>
            <p>Booking dihitung menurut waktu mulai pada periode. Draf dan booking terhapus tidak dihitung; “Terjadwal / berjalan” adalah diminta, dikonfirmasi, dan sedang berjalan.</p>
            <p>Kunjungan manual (di luar booking) tidak termasuk. Peran dengan akses cabang terbatas hanya melihat cabangnya.</p>
          </Definition>
        </div>
      ) : <Unavailable title="Operasional" state={operations} />}

      {finance.status === "hidden" ? null : finance.status === "ready" ? (
        <div className={sectionClass}>
          <div className="mb-4 flex items-center justify-between gap-3"><h3 className="font-bold text-[#1a2233]">Keuangan</h3><Link href="/finance" className="text-xs font-bold text-[#0f8a72]">Buka keuangan</Link></div>
          {finance.data.currencies.length === 0 ? <EmptyState title="Belum ada data keuangan pada periode ini" description="Tidak ada invoice terbit, pembayaran, refund, atau invoice belum lunas pada cabang yang dapat Anda akses." /> : (
            <div className="space-y-5">
              {financeMulti ? <p role="note" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">Terdapat lebih dari satu mata uang. Angka ditampilkan per mata uang dan tidak dijumlahkan.</p> : null}
              {finance.data.currencies.map((entry) => <FinanceBlock key={entry.currency} entry={entry} multi={financeMulti} />)}
            </div>
          )}
          <Definition>
            <p>Invoice terbit: invoice tidak batal menurut tanggal terbit. Pembayaran diterima: pembayaran berstatus berhasil menurut tanggal bayar; pembayaran menunggu atau gagal tidak dihitung. Refund: refund berhasil menurut tanggal refund.</p>
            <p>Invoice belum lunas: invoice berstatus terbit yang totalnya masih melebihi pembayaran berhasil; posisi saat ini, bukan per periode.</p>
            <p>Ini bukan laba, arus kas bersih, maupun saldo kas: biaya, gaji, dan saldo awal tidak termasuk.</p>
          </Definition>
        </div>
      ) : <Unavailable title="Keuangan" state={finance} />}

      {sources.status === "hidden" ? null : sources.status === "ready" ? (
        <div className={sectionClass}>
          <div className="mb-4 flex items-center justify-between gap-3"><h3 className="font-bold text-[#1a2233]">Performa sumber pelanggan</h3><Link href="/customers" className="text-xs font-bold text-[#0f8a72]">Buka pelanggan</Link></div>
          <Sources data={sources.data} />
          <SourceReturnBlock state={performance.sourceReturn} canManageSpend={canManageSpend} />
          <Definition>
            <p>Sumber adalah isian “sumber” pada profil pelanggan saat ini (huruf besar/kecil dan spasi diseragamkan). Mengubah sumber pelanggan mengubah atribusinya, termasuk untuk periode lalu.</p>
            <p>Pelanggan baru: pelanggan tidak diarsipkan menurut tanggal dibuat. Booking selesai pertama: booking selesai paling awal milik pelanggan jatuh pada periode. Pembayaran invoice pertama: pembayaran berhasil paling awal pada invoice tidak batal jatuh pada periode. Pelanggan lama dapat muncul di dua kolom terakhir.</p>
            <p>Hingga sepuluh sumber teratas ditampilkan; sisanya digabung. Tanpa sumber ditampilkan terpisah. Tidak ada data identitas atau kontak pelanggan di tabel ini.</p>
            {!sources.data.bookingColumnAvailable ? <p>Kolom booking selesai pertama membutuhkan booking.read.</p> : null}
            {!sources.data.financeColumnAvailable ? <p>Kolom pembayaran pertama membutuhkan finance.read.</p> : null}
          </Definition>
        </div>
      ) : <Unavailable title="Performa sumber pelanggan" state={sources} />}
    </section>
  );
}
