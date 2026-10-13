/**
 * Function index:
 * - CashOnHandPanel: the mapped cash position per account and what it leaves out.
 * - CashMappingList: the mapping history, newest first.
 *
 * The position is declared register movements plus the flows the owner mapped to each account. It is not a bank reconciliation.
 * An organization-wide account is shown without a mapped total to a caller who cannot see every branch, and never summed.
 */
import Link from "next/link";

import { formatMoney } from "@/lib/dashboard-performance";
import {
  FLOW_KIND_LABELS, FLOW_LABELS, METHOD_LABELS, ON_HAND_DEFINITION, summarizeOnHand, UNMAPPED_REASON_LABELS, type CashMapping, type CashOnHand,
} from "@/lib/cash-mapping";

export function CashOnHandPanel({ onHand, error, canManage, asOfLabel }: { onHand: CashOnHand | null; error: string | null; canManage: boolean; asOfLabel: string }) {
  const totals = onHand ? summarizeOnHand(onHand.accounts) : [];
  return (
    <section aria-label="Kas di tangan" className="rounded-3xl border border-emerald-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-bold">Kas di tangan (terpetakan)</h2><p className="text-xs text-slate-500">{asOfLabel}</p></div>
        <Link href="/finance/register/mapping" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800">{canManage ? "Kelola pemetaan" : "Lihat pemetaan"}</Link>
      </div>
      {error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</p> : null}
      {onHand === null ? null : onHand.accounts.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 p-4 text-xs text-slate-500">Belum ada akun kas yang dapat Anda lihat.</p>
      ) : <>
        {!onHand.hasMappings ? (
          <p role="note" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">Belum ada pemetaan, jadi angka di bawah hanya berisi mutasi yang dicatat di register. Petakan metode pembayaran, pengeluaran, dan gaji ke akun agar arus Operro ikut dihitung.</p>
        ) : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {totals.map((total) => (
            <div key={total.currency} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{total.currency} · {total.accounts} akun lengkap</p>
              <p className={`mt-1 text-xl font-bold ${total.balance < 0 ? "text-rose-700" : "text-slate-900"}`}>{formatMoney(total.balance, total.currency)}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-[11px] uppercase text-slate-400"><tr><th className="py-2 pr-3">Akun</th><th className="pr-3 text-right">Dicatat</th><th className="pr-3 text-right">Pembayaran</th><th className="pr-3 text-right">Refund</th><th className="pr-3 text-right">Pengeluaran</th><th className="pr-3 text-right">Gaji</th><th className="text-right">Saldo terpetakan</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {onHand.accounts.map((account) => {
                const money = (value: number | null) => (value === null ? "—" : formatMoney(value, account.currency));
                return (
                  <tr key={account.id} className={account.status === "archived" ? "text-slate-400" : ""}>
                    <td className="py-2 pr-3 font-semibold">{account.name} <span className="text-slate-400">({account.currency})</span>{account.firstEffective ? <span className="ml-2 text-[10px] font-normal text-slate-400">sejak {account.firstEffective}</span> : null}</td>
                    <td className="pr-3 text-right">{money(account.declared)}</td>
                    <td className="pr-3 text-right">{account.complete ? money(account.paymentsIn) : "—"}</td>
                    <td className="pr-3 text-right">{account.complete ? money(account.refundsOut) : "—"}</td>
                    <td className="pr-3 text-right">{account.complete ? money(account.expensesOut) : "—"}</td>
                    <td className="pr-3 text-right">{account.complete ? money(account.payrollOut) : "—"}</td>
                    <td className="text-right font-bold">{account.complete ? money(account.balance) : <span className="font-normal text-slate-500" title="Akun seluruh cabang: total terpetakan memerlukan akses semua cabang agar tidak mengabaikan cabang lain.">Perlu akses semua cabang</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {onHand.unmapped.length > 0 ? (
          <div className="mt-5" aria-label="Arus yang tidak dihitung">
            <h3 className="text-sm font-bold text-slate-800">Arus yang tidak masuk saldo di atas</h3>
            <p className="mt-1 text-[11px] text-slate-500">Sejak tanggal berlaku pemetaan paling awal, pada cabang yang dapat Anda akses. Jumlah tidak digabung antar mata uang.</p>
            <ul className="mt-2 space-y-1 text-xs text-slate-700">
              {onHand.unmapped.map((item) => (
                <li key={`${item.kind}:${item.currency}:${item.reason}`}><span className="font-semibold">{FLOW_KIND_LABELS[item.kind] ?? item.kind}</span> · {item.count} arus · {formatMoney(item.total, item.currency)} · {UNMAPPED_REASON_LABELS[item.reason] ?? item.reason}</li>
              ))}
            </ul>
          </div>
        ) : onHand.hasMappings ? <p className="mt-4 text-xs text-slate-500">Semua arus sejak pemetaan pertama masuk ke saldo di atas.</p> : null}
        <ul className="mt-4 list-disc space-y-1 pl-5 text-[11px] leading-5 text-slate-500">{ON_HAND_DEFINITION.map((line) => <li key={line}>{line}</li>)}</ul>
      </>}
    </section>
  );
}

export function CashMappingList({ mappings, accountNames, branchNames }: { mappings: readonly CashMapping[]; accountNames: ReadonlyMap<string, string>; branchNames: ReadonlyMap<string, string> }) {
  if (mappings.length === 0) return <p className="mt-3 rounded-lg bg-slate-50 p-4 text-xs text-slate-500">Belum ada pemetaan. Tanpa pemetaan, saldo hanya berisi mutasi yang dicatat di register.</p>;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="text-[11px] uppercase text-slate-400"><tr><th className="py-2 pr-3">Berlaku mulai</th><th className="pr-3">Arus</th><th className="pr-3">Cabang</th><th className="pr-3">Akun tujuan</th><th>Dicatat</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {mappings.map((mapping) => (
            <tr key={mapping.id}>
              <td className="py-2 pr-3">{mapping.effectiveFrom}</td>
              <td className="pr-3">{FLOW_LABELS[mapping.flow]}{mapping.method ? ` · ${METHOD_LABELS[mapping.method]}` : ""}</td>
              <td className="pr-3">{mapping.branchId ? branchNames.get(mapping.branchId) ?? "Cabang" : "Semua cabang"}</td>
              <td className="pr-3 font-semibold">{mapping.accountId ? accountNames.get(mapping.accountId) ?? "Akun" : <span className="font-normal text-slate-500">Dihentikan</span>}</td>
              <td>{mapping.createdAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
