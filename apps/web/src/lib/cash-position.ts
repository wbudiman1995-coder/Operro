/**
 * Function index:
 * - parseCashPeriod: validates ?from&to (YYYY-MM-DD) or defaults to the current month in the business zone.
 * - loadCashPosition: calls app.finance_cash_position (read-only, RLS-scoped, finance.read) and shapes rows.
 * - groupCashByCurrency: per-currency grand totals; amounts of different currencies are never added together.
 *
 * This is a report over payment, refund and expense rows, NOT an accounting ledger: it has no opening balance,
 * capital, inter-account transfer or tax, and it writes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isValidDateISO, zonedDayISO } from "@/lib/timezone";

export interface CashPeriod { from: string; to: string }
export interface CashPositionRow {
  period: string;
  currency: string;
  paymentsIn: number;
  paymentsCount: number;
  refundsOut: number;
  refundsCount: number;
  expensesOut: number;
  expensesCount: number;
  net: number;
  excludedPayments: number;
}
export interface CashCurrencyTotal {
  currency: string;
  paymentsIn: number;
  refundsOut: number;
  expensesOut: number;
  net: number;
  excludedPayments: number;
}

export const MAX_CASH_PERIOD_DAYS = 366;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A missing range means "this month so far" in the business time zone. A bad range is an error, never a guess. */
export function parseCashPeriod(
  from: string | undefined | null,
  to: string | undefined | null,
  now: Date,
  timeZone: string,
): { ok: true; period: CashPeriod } | { ok: false; message: string } {
  if (!from && !to) {
    const today = zonedDayISO(now, timeZone);
    return { ok: true, period: { from: `${today.slice(0, 8)}01`, to: today } };
  }
  if (!isValidDateISO(from) || !isValidDateISO(to)) return { ok: false, message: "Tanggal harus berformat YYYY-MM-DD." };
  if (from > to) return { ok: false, message: "Tanggal mulai tidak boleh setelah tanggal akhir." };
  if (daysBetween(from, to) > MAX_CASH_PERIOD_DAYS) return { ok: false, message: `Periode maksimal ${MAX_CASH_PERIOD_DAYS} hari.` };
  if (from < "2000-01-01" || to > "2100-12-31") return { ok: false, message: "Periode di luar batas yang didukung." };
  return { ok: true, period: { from, to } };
}

interface CashRpcRow {
  period: string; currency: string; payments_in: number | string; payments_count: number; refunds_out: number | string;
  refunds_count: number; expenses_out: number | string; expenses_count: number; net: number | string; excluded_payments: number;
}

export async function loadCashPosition(supabase: SupabaseClient, period: CashPeriod, timeZone: string): Promise<CashPositionRow[]> {
  const { data, error } = await supabase.schema("app").rpc("finance_cash_position", { p_from: period.from, p_to: period.to, p_timezone: timeZone });
  if (error) throw new Error(`cash_position_failed:${error.code ?? ""}:${error.message}`);
  return ((data ?? []) as CashRpcRow[]).map((row) => ({
    period: row.period, currency: row.currency,
    paymentsIn: Number(row.payments_in), paymentsCount: row.payments_count,
    refundsOut: Number(row.refunds_out), refundsCount: row.refunds_count,
    expensesOut: Number(row.expenses_out), expensesCount: row.expenses_count,
    net: Number(row.net), excludedPayments: row.excluded_payments,
  }));
}

export function groupCashByCurrency(rows: readonly CashPositionRow[]): CashCurrencyTotal[] {
  const totals = new Map<string, CashCurrencyTotal>();
  for (const row of rows) {
    const total = totals.get(row.currency) ?? { currency: row.currency, paymentsIn: 0, refundsOut: 0, expensesOut: 0, net: 0, excludedPayments: 0 };
    total.paymentsIn += row.paymentsIn; total.refundsOut += row.refundsOut; total.expensesOut += row.expensesOut;
    total.net += row.net; total.excludedPayments += row.excludedPayments;
    totals.set(row.currency, total);
  }
  const cents = (value: number) => Math.round(value * 100) / 100;
  return [...totals.values()]
    .map((t) => ({ ...t, paymentsIn: cents(t.paymentsIn), refundsOut: cents(t.refundsOut), expensesOut: cents(t.expensesOut), net: cents(t.net) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
