/**
 * Function index:
 * - MarketingSpendPanel: net spend per currency, the entry history and (for finance.manage) the recording forms.
 *
 * Spend is declared by a person; it is not read from any advertising platform. The page says what the return on the
 * dashboard does and does not mean, and never shows a ratio itself.
 */
import Link from "next/link";

import { ReverseSpendForm, SpendForm } from "@/components/marketing-spend-forms";
import { formatMoney } from "@/lib/dashboard-performance";
import { groupSpendByCurrency, RETURN_DEFINITION, type MarketingSpend } from "@/lib/marketing-spend";

export function MarketingSpendPanel({ spend, canManage, today, requestKeys, error, nextHref, sourceLabels = [] }: {
  spend: MarketingSpend | null;
  canManage: boolean;
  today: string;
  requestKeys: { entry: string; reversals: Record<string, string> };
  error: string | null;
  nextHref: string | null;
  /** The organization's suggested source labels (business defaults); merged with labels already used in the ledger. */
  sourceLabels?: readonly string[];
}) {
  const totals = spend ? groupSpendByCurrency(spend.entries) : [];
  const suggestions = [...new Set([...sourceLabels, ...(spend ? spend.entries.map((entry) => entry.sourceLabel) : [])])].slice(0, 40);
  return (
    <div className="mt-6 space-y-6">
      <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
        Biaya di sini adalah catatan manual: Operro tidak membaca biaya iklan dari platform mana pun. Catatan tidak dapat diubah atau dihapus; koreksi dengan pembalikan. Biaya dipakai untuk ROI sederhana per sumber di <Link href="/dashboard" className="font-bold underline">Dasbor</Link>.
      </p>
      {error ? <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</p> : null}

      {canManage ? (
        <section aria-label="Catat biaya" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="font-bold">Catat biaya pemasaran</h2>
          <p className="mt-1 text-xs text-slate-500">Satu catatan = satu sumber, satu hari, satu mata uang. Nama sumber disamakan dengan isian “sumber” pada profil pelanggan (huruf besar/kecil dan spasi tidak dibedakan).</p>
          <div className="mt-4"><SpendForm initialKey={requestKeys.entry} today={today} suggestions={suggestions} /></div>
        </section>
      ) : <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">Peran Anda dapat melihat biaya pemasaran, tetapi tidak memiliki finance.manage untuk mencatat atau membaliknya.</p>}

      <section aria-label="Riwayat biaya" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="font-bold">Riwayat biaya</h2>
        {spend === null ? null : spend.entries.length === 0 ? <p className="mt-3 rounded-lg bg-slate-50 p-4 text-xs text-slate-500">Belum ada biaya pemasaran tercatat. Tanpa biaya, ROI per sumber tidak tersedia.</p> : <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {totals.map((total) => (
              <div key={total.currency} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{total.currency} · halaman ini</p>
                <p className="mt-1 text-xl font-bold text-slate-900">{formatMoney(total.net, total.currency)}</p>
                <p className="text-[11px] text-slate-500">Biaya bersih setelah pembalikan, hanya untuk baris yang tampil.</p>
              </div>
            ))}
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-[11px] uppercase text-slate-400"><tr><th className="py-2 pr-3">Tanggal</th><th className="pr-3">Sumber</th><th className="pr-3 text-right">Jumlah</th><th className="pr-3">Catatan</th>{canManage ? <th className="text-right">Koreksi</th> : null}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {spend.entries.map((entry) => {
                  const reversed = spend.reversed.has(entry.id);
                  return (
                    <tr key={entry.id} className={reversed ? "text-slate-400" : ""}>
                      <td className="py-2 pr-3">{entry.spentOn}</td>
                      <td className="pr-3 font-semibold">{entry.sourceLabel}{entry.kind === "reversal" ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold">pembalikan</span> : null}{reversed ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold">dibalik</span> : null}</td>
                      <td className={`pr-3 text-right font-bold ${entry.kind === "reversal" ? "text-emerald-700" : ""}`}>{entry.kind === "reversal" ? "−" : ""}{formatMoney(entry.amount, entry.currency)}</td>
                      <td className="max-w-[16rem] truncate pr-3">{entry.note ?? "—"}</td>
                      {canManage ? <td className="text-right">{entry.kind === "spend" && !reversed ? <ReverseSpendForm entryId={entry.id} initialKey={requestKeys.reversals[entry.id] ?? ""} /> : null}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>}
        {nextHref ? <div className="mt-4 text-center"><Link href={nextHref} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700">Muat lebih banyak</Link></div> : null}
      </section>

      <section aria-label="Arti ROI" className="rounded-3xl border border-slate-200 bg-white p-5 text-xs leading-5 text-slate-600 shadow-sm sm:p-6">
        <h2 className="text-sm font-bold text-slate-900">Apa arti ROI sederhana di dasbor</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">{RETURN_DEFINITION.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>
    </div>
  );
}
