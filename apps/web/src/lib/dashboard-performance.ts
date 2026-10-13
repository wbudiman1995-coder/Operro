/**
 * Function index:
 * - loadDashboardPerformance: runs the three capability-gated performance aggregates for one period.
 * - parseOperationsRows / parseFinanceRows / parseSourceRows: shape database rows into display data (pure).
 * - formatMoney: currency-aware money text; amounts of different currencies are never added together.
 * - describeChange: neutral "vs previous period" text for a count or an amount.
 *
 * The aggregates are database functions (migration 20261030100000, SECURITY DEFINER with in-function checks): the organization comes from
 * the authenticated session inside the database, branch visibility from the caller's branch grants, and a caller without
 * the capability is refused there as well. This loader additionally refuses to even issue a call a role may not
 * make, so a denied card shows "unavailable" and never a misleading zero. It sends no organization identifier.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { BranchAccess, CapabilityMap } from "@/lib/authorization";
import type { DashboardPeriod } from "@/lib/dashboard-period";
import { buildPerformanceReadPlan, DASHBOARD_CARD_DEFAULTS, type DashboardCardVisibility } from "@/lib/dashboard-read-model";
import { loadSourceReturn, type SourceReturn } from "@/lib/marketing-spend";

export type CardState<T> =
  /** The organization turned this card off: nothing is queried and nothing is shown. */
  | { status: "hidden" }
  /** The caller lacks a capability or branch access: nothing was queried. */
  | { status: "restricted"; reason: string }
  /** The read itself failed or the database lacks the feature: shown as unavailable, never as zero. */
  | { status: "unavailable"; reason: string }
  | { status: "ready"; data: T };

export interface OperationsFigures { completed: number; open: number; canceled: number; noShow: number }
export interface OperationsData { current: OperationsFigures; previous: OperationsFigures }

export interface FinanceFigures {
  issuedTotal: number; issuedCount: number;
  collectedTotal: number; collectedCount: number; collectedOnVoid: number;
  refundedTotal: number; refundedCount: number;
}
export interface OutstandingFigures { total: number; count: number; overdue: number }
export interface FinanceCurrency { currency: string; current: FinanceFigures; previous: FinanceFigures; outstanding: OutstandingFigures }
export interface FinanceData { currencies: FinanceCurrency[] }

export interface SourceFigures { newCustomers: number; firstCompleted: number | null; firstPaid: number | null }
export interface SourceRow {
  key: string;
  kind: "named" | "other" | "missing";
  label: string | null;
  /** Distinct sources folded into an "other" row (current period). */
  sourceCount: number;
  current: SourceFigures;
  previous: SourceFigures;
}
export interface SourceData { rows: SourceRow[]; bookingColumnAvailable: boolean; financeColumnAvailable: boolean }

export interface DashboardPerformance {
  operations: CardState<OperationsData>;
  finance: CardState<FinanceData>;
  sources: CardState<SourceData>;
  /** Cash collected from this period's new customers per source against recorded marketing spend (migration 20261101100000). */
  sourceReturn: CardState<SourceReturn>;
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? data.filter((row): row is Row => typeof row === "object" && row !== null) : []);

const zeroOperations = (): OperationsFigures => ({ completed: 0, open: 0, canceled: 0, noShow: 0 });
export function parseOperationsRows(data: unknown): OperationsData {
  const result: OperationsData = { current: zeroOperations(), previous: zeroOperations() };
  for (const row of rowsOf(data)) {
    if (row.period !== "current" && row.period !== "previous") continue;
    result[row.period] = { completed: num(row.completed), open: num(row.open_count), canceled: num(row.canceled), noShow: num(row.no_show) };
  }
  return result;
}

const zeroFinance = (): FinanceFigures => ({ issuedTotal: 0, issuedCount: 0, collectedTotal: 0, collectedCount: 0, collectedOnVoid: 0, refundedTotal: 0, refundedCount: 0 });
export function parseFinanceRows(data: unknown): FinanceData {
  const byCurrency = new Map<string, FinanceCurrency>();
  for (const row of rowsOf(data)) {
    if (typeof row.currency !== "string" || row.currency === "") continue;
    const entry = byCurrency.get(row.currency) ?? { currency: row.currency, current: zeroFinance(), previous: zeroFinance(), outstanding: { total: 0, count: 0, overdue: 0 } };
    if (row.period === "snapshot") {
      entry.outstanding = { total: num(row.outstanding_total), count: num(row.outstanding_count), overdue: num(row.overdue_count) };
    } else if (row.period === "current" || row.period === "previous") {
      entry[row.period] = {
        issuedTotal: num(row.issued_total), issuedCount: num(row.issued_count),
        collectedTotal: num(row.collected_total), collectedCount: num(row.collected_count), collectedOnVoid: num(row.collected_on_void_count),
        refundedTotal: num(row.refunded_total), refundedCount: num(row.refunded_count),
      };
    } else continue;
    byCurrency.set(row.currency, entry);
  }
  // IDR first (the application's home currency), then alphabetical: a stable, predictable order.
  const currencies = [...byCurrency.values()].sort((a, b) => (a.currency === "IDR" ? -1 : b.currency === "IDR" ? 1 : a.currency.localeCompare(b.currency)));
  return { currencies };
}

const emptySource = (booking: boolean, finance: boolean): SourceFigures => ({ newCustomers: 0, firstCompleted: booking ? 0 : null, firstPaid: finance ? 0 : null });
const weight = (figures: SourceFigures) => figures.newCustomers + (figures.firstCompleted ?? 0) + (figures.firstPaid ?? 0);
export function parseSourceRows(data: unknown, bookingColumnAvailable: boolean, financeColumnAvailable: boolean): SourceData {
  const byKey = new Map<string, SourceRow>();
  for (const row of rowsOf(data)) {
    if (row.period !== "current" && row.period !== "previous") continue;
    const kind: SourceRow["kind"] = row.is_missing === true ? "missing" : row.is_other === true ? "other" : "named";
    const label = kind === "named" && typeof row.source_label === "string" ? row.source_label : null;
    const key = kind === "named" ? `n:${(label ?? "").toLowerCase()}` : kind;
    const entry = byKey.get(key) ?? { key, kind, label, sourceCount: 0, current: emptySource(bookingColumnAvailable, financeColumnAvailable), previous: emptySource(bookingColumnAvailable, financeColumnAvailable) };
    entry[row.period] = {
      newCustomers: num(row.new_customers),
      firstCompleted: bookingColumnAvailable ? nullableNum(row.first_completed) : null,
      firstPaid: financeColumnAvailable ? nullableNum(row.first_paid) : null,
    };
    if (row.period === "current") entry.sourceCount = num(row.source_count);
    byKey.set(key, entry);
  }
  const order = { named: 0, other: 1, missing: 2 } as const;
  const rows = [...byKey.values()].sort((a, b) => order[a.kind] - order[b.kind] || weight(b.current) - weight(a.current) || weight(b.previous) - weight(a.previous) || a.key.localeCompare(b.key));
  return { rows, bookingColumnAvailable, financeColumnAvailable };
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("id-ID", { style: "currency", currency, maximumFractionDigits: currency === "IDR" ? 0 : 2 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export interface ChangeText { direction: "up" | "down" | "same"; text: string }
/** Neutral wording: a rise is not "good" (cancellations) and a fall is not "bad" (refunds). */
export function describeChange(current: number, previous: number, format: (value: number) => string = String): ChangeText {
  if (current === previous) return { direction: "same", text: `Sama dengan periode sebelumnya (${format(previous)}).` };
  const direction = current > previous ? "up" : "down";
  const delta = `${current > previous ? "+" : "−"}${format(Math.abs(current - previous))}`;
  const percent = previous > 0 ? ` (${current > previous ? "+" : "−"}${Math.round((Math.abs(current - previous) / previous) * 100)}%)` : "";
  return { direction, text: `${delta}${percent} dibanding periode sebelumnya (${format(previous)}).` };
}

const PARAMS = (period: DashboardPeriod, timeZone: string) => ({
  p_from: period.current.from, p_to: period.current.to, p_prev_from: period.previous.from, p_prev_to: period.previous.to, p_timezone: timeZone,
});

async function run<T>(
  supabase: SupabaseClient, scope: string, fn: string, period: DashboardPeriod, timeZone: string, parse: (data: unknown) => T,
): Promise<CardState<T>> {
  try {
    const { data, error } = await supabase.schema("app").rpc(fn, PARAMS(period, timeZone));
    if (error) {
      if (error.code === "42501") return { status: "restricted", reason: "Akses ditolak oleh database untuk peran ini; angka tidak ditampilkan." };
      if (error.code === "PGRST202" || error.code === "42883") return { status: "unavailable", reason: "Fitur ini belum tersedia di database yang terhubung (migrasi 20261030100000 belum diterapkan)." };
      console.error(`dashboard_performance_${scope}_failed`, { code: error.code });
      return { status: "unavailable", reason: "Data tidak dapat dimuat saat ini. Coba muat ulang halaman." };
    }
    return { status: "ready", data: parse(data) };
  } catch (cause) {
    console.error(`dashboard_performance_${scope}_failed`, cause instanceof Error ? cause.message : "unknown");
    return { status: "unavailable", reason: "Data tidak dapat dimuat saat ini. Coba muat ulang halaman." };
  }
}

async function runSourceReturn(supabase: SupabaseClient, period: DashboardPeriod, timeZone: string): Promise<CardState<SourceReturn>> {
  try {
    return { status: "ready", data: await loadSourceReturn(supabase, period.current.from, period.current.to, timeZone) };
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "42501") return { status: "restricted", reason: "Akses ditolak oleh database untuk peran ini; angka tidak ditampilkan." };
    if (code === "PGRST202" || code === "42883") return { status: "unavailable", reason: "ROI per sumber belum tersedia di database yang terhubung (migrasi 20261101100000 belum diterapkan)." };
    console.error("dashboard_performance_source_return_failed", { code });
    return { status: "unavailable", reason: "ROI per sumber tidak dapat dimuat saat ini. Tabel pelanggan di atas tidak terpengaruh." };
  }
}

const hidden = { status: "hidden" } as const;
const noBranch = "Belum ada cabang yang diberikan kepada peran ini.";

export async function loadDashboardPerformance(
  supabase: SupabaseClient,
  capabilities: CapabilityMap,
  branchAccess: BranchAccess,
  period: DashboardPeriod,
  timeZone: string,
  visibility: DashboardCardVisibility = DASHBOARD_CARD_DEFAULTS,
): Promise<DashboardPerformance> {
  const plan = buildPerformanceReadPlan(capabilities, branchAccess, visibility);
  const hasBranch = branchAccess.all || branchAccess.ids.size > 0;
  const canCustomers = capabilities["customer.read"] || capabilities["customer.manage"];

  const operations: Promise<CardState<OperationsData>> = !visibility.performance_operations ? Promise.resolve(hidden)
    : !capabilities["booking.read"] ? Promise.resolve({ status: "restricted", reason: "Peran ini tidak memiliki booking.read; angka tidak dimuat." })
    : !hasBranch ? Promise.resolve({ status: "restricted", reason: noBranch })
    : plan.operations ? run(supabase, "operations", "dashboard_operations_performance", period, timeZone, parseOperationsRows)
    : Promise.resolve(hidden);

  const finance: Promise<CardState<FinanceData>> = !visibility.performance_finance ? Promise.resolve(hidden)
    : !capabilities["finance.read"] ? Promise.resolve({ status: "restricted", reason: "Peran ini tidak memiliki finance.read; angka tidak dimuat." })
    : !hasBranch ? Promise.resolve({ status: "restricted", reason: noBranch })
    : plan.finance ? run(supabase, "finance", "dashboard_finance_performance", period, timeZone, parseFinanceRows)
    : Promise.resolve(hidden);

  const sources: Promise<CardState<SourceData>> = !visibility.performance_sources ? Promise.resolve(hidden)
    : !canCustomers ? Promise.resolve({ status: "restricted", reason: "Peran ini tidak memiliki customer.read atau customer.manage; sumber pelanggan tidak dimuat." })
    : !branchAccess.all ? Promise.resolve({ status: "restricted", reason: "Pelanggan tidak terikat cabang, sehingga rincian sumber hanya tersedia bagi peran dengan akses semua cabang." })
    : plan.sources ? run(supabase, "sources", "dashboard_source_performance", period, timeZone, (data) => parseSourceRows(data, plan.sourcesBooking, plan.sourcesFinance))
    : Promise.resolve(hidden);

  // The return needs everything the sources card needs plus finance.read; a caller missing any of it makes no query.
  const sourceReturn: Promise<CardState<SourceReturn>> = !visibility.performance_sources ? Promise.resolve(hidden)
    : !canCustomers || !branchAccess.all ? Promise.resolve({ status: "restricted", reason: "ROI per sumber hanya tersedia bagi peran dengan akses pelanggan dan semua cabang." })
    : !capabilities["finance.read"] ? Promise.resolve({ status: "restricted", reason: "ROI per sumber memerlukan finance.read; angka tidak dimuat." })
    : runSourceReturn(supabase, period, timeZone);

  const [operationsState, financeState, sourcesState, sourceReturnState] = await Promise.all([operations, finance, sources, sourceReturn]);
  return { operations: operationsState, finance: financeState, sources: sourcesState, sourceReturn: sourceReturnState };
}
