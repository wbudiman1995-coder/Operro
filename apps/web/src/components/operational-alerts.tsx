/**
 * Function index:
 * - OperationalAlerts: read-only list of threshold-based alerts; each says what it measures and links to one page.
 *
 * A zero is only shown for an alert that was actually measured. Alerts the caller may not load are listed once, by
 * name, so a missing alert is never mistaken for "nothing to report".
 */
import Link from "next/link";

import { ALERT_DEFINITIONS, type AlertResult, type AlertsState } from "@/lib/dashboard-alerts";
import { formatMoney } from "@/lib/dashboard-performance";

const sectionClass = "rounded-[14px] border border-[#e4e7ec] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.06)] sm:p-7";

function headline(result: Extract<AlertResult, { status: "ready" }>): string {
  const count = `${result.count}${result.capped ? "+" : ""}`;
  if (result.key === "unbilled_visits") return `${count} kunjungan`;
  if (result.key === "overdue_invoices") return `${count} invoice`;
  if (result.key === "expiring_packages") return `${count} paket`;
  if (result.key === "stale_open_bookings") return `${count} booking`;
  return `${count} pekerjaan`;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function OperationalAlerts({ state }: { state: AlertsState }) {
  if (state.status === "hidden") return null;
  const ready = state.alerts.filter((alert): alert is Extract<AlertResult, { status: "ready" }> => alert.status === "ready");
  const withItems = ready.filter((alert) => alert.count > 0);
  const notShown = state.alerts.filter((alert) => alert.status !== "ready");
  const restricted = notShown.filter((alert) => alert.status === "restricted");
  const failed = notShown.filter((alert) => alert.status === "unavailable");
  return (
    <section aria-label="Peringatan operasional" className={`mt-8 ${sectionClass}`}>
      <h2 className="text-lg font-bold text-[#1a2233]">Peringatan operasional</h2>
      <p className="mt-1 text-xs text-[#5b6472]">Hitungan dari catatan yang ada dengan ambang tetap. Bukan skor atau perkiraan, dan tidak mengikuti periode di bawah.</p>

      {ready.length === 0 ? (
        <p role="status" className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm text-slate-600">Tidak ada peringatan yang dapat dimuat untuk peran atau cabang ini.</p>
      ) : withItems.length === 0 ? (
        <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">Tidak ada item yang melewati ambang untuk {ready.length} pemeriksaan yang dimuat. Ini bukan jaminan seluruh data benar.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {withItems.map((alert) => {
            const definition = ALERT_DEFINITIONS[alert.key];
            const oldest = formatDate(alert.oldestAt);
            return (
              <li key={alert.key} className="rounded-[11px] border-l-4 border-amber-500 bg-amber-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#1a2233]">{definition.title}: {headline(alert)}</p>
                    {alert.amounts.length > 0 ? <p className="mt-1 text-xs font-semibold text-amber-900">Sisa tagihan: {alert.amounts.map((entry) => `${formatMoney(entry.amount, entry.currency)} (${entry.count})`).join(" · ")}</p> : null}
                    {oldest ? <p className="mt-1 text-[11px] text-[#5b6472]">{alert.key === "expiring_packages" ? "Paling cepat berakhir" : "Paling lama"}: {oldest}</p> : null}
                  </div>
                  <Link href={definition.href} className="shrink-0 text-xs font-bold text-[#0f8a72]">{definition.linkLabel}</Link>
                </div>
                <details className="mt-2 text-[11px] text-[#5b6472]"><summary className="cursor-pointer font-semibold text-[#0f8a72]">Apa yang diukur</summary><p className="mt-1 leading-5">{definition.measures}</p></details>
              </li>
            );
          })}
        </ul>
      )}

      {ready.length > 0 && withItems.length > 0 ? (
        <p className="mt-3 text-[11px] text-[#8a93a3]">Diperiksa tanpa temuan: {ready.filter((alert) => alert.count === 0).map((alert) => ALERT_DEFINITIONS[alert.key].title).join(", ") || "—"}.</p>
      ) : null}
      {restricted.length > 0 ? <p className="mt-2 text-[11px] text-[#8a93a3]">Tidak dimuat karena izin atau cabang peran ini: {restricted.map((alert) => ALERT_DEFINITIONS[alert.key].title).join(", ")}.</p> : null}
      {failed.length > 0 ? <p role="alert" className="mt-2 text-[11px] font-semibold text-rose-700">Belum dapat dimuat saat ini (bukan berarti nol): {failed.map((alert) => ALERT_DEFINITIONS[alert.key].title).join(", ")}.</p> : null}
      <p className="mt-3 text-[11px] text-[#8a93a3]">Double-booking sumber daya tidak diperiksa karena database sudah menolaknya. Biaya pemasaran per sumber tidak tercatat, sehingga ROI sumber tidak tersedia.</p>
    </section>
  );
}
