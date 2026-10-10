/**
 * Function index:
 * - resolveDashboardPeriod: validates the ?period=&from=&to= selection and returns the current range plus the
 *   immediately preceding equal-length range, both as inclusive business-time-zone calendar dates.
 * - formatDashboardRange: Indonesian label for an inclusive date range.
 *
 * This is the ONLY place the dashboard's period boundaries are defined. The values go to the database as plain
 * dates plus the business time zone (the aggregates re-check adjacency, equal length and the 366-day cap), so no
 * boundary is ever computed in browser-local time or in the server process time zone.
 */
import { addDaysISO, isValidDateISO, zonedDayISO } from "@/lib/timezone";

export const DASHBOARD_PERIOD_PRESETS = ["today", "7d", "30d", "month", "last_month", "custom"] as const;
export type DashboardPeriodPreset = (typeof DASHBOARD_PERIOD_PRESETS)[number];
export const DEFAULT_DASHBOARD_PERIOD = "today" satisfies DashboardPeriodPreset;
export const MAX_DASHBOARD_PERIOD_DAYS = 366;
/** Mirrors the database lower bound; the comparison range must stay inside it. */
const EARLIEST_DATE = "2000-01-01";

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriodPreset, string> = {
  today: "Hari ini",
  "7d": "7 hari terakhir",
  "30d": "30 hari terakhir",
  month: "Bulan ini",
  last_month: "Bulan lalu",
  custom: "Rentang khusus",
};

export interface DashboardRange { from: string; to: string }
export interface DashboardPeriod {
  preset: DashboardPeriodPreset;
  current: DashboardRange;
  previous: DashboardRange;
  /** Inclusive calendar days in each range. */
  days: number;
  /** Today in the business time zone. */
  today: string;
  label: string;
  comparisonLabel: string;
}
export type DashboardPeriodResolution =
  | { ok: true; period: DashboardPeriod }
  /** `period` is the safe default, so the page can still render while telling the user why the input was refused. */
  | { ok: false; message: string; period: DashboardPeriod };
export interface DashboardPeriodInput { period?: string | string[]; from?: string | string[]; to?: string | string[] }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function parts(dateISO: string) {
  const [year, month, day] = dateISO.split("-").map(Number);
  return { year, month, day };
}

export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function formatDashboardRange(range: DashboardRange): string {
  const a = parts(range.from);
  const b = parts(range.to);
  const left = `${a.day} ${MONTHS[a.month - 1]} ${a.year}`;
  if (range.from === range.to) return left;
  if (a.year === b.year && a.month === b.month) return `${a.day}–${b.day} ${MONTHS[b.month - 1]} ${b.year}`;
  return `${left} – ${b.day} ${MONTHS[b.month - 1]} ${b.year}`;
}

function build(preset: DashboardPeriodPreset, current: DashboardRange, today: string): DashboardPeriod {
  const days = inclusiveDays(current.from, current.to);
  const previous = { from: addDaysISO(current.from, -days), to: addDaysISO(current.from, -1) };
  return {
    preset,
    current,
    previous,
    days,
    today,
    label: `${DASHBOARD_PERIOD_LABELS[preset]} · ${formatDashboardRange(current)}`,
    comparisonLabel: `Dibanding ${days === 1 ? "hari" : `${days} hari`} sebelumnya · ${formatDashboardRange(previous)}`,
  };
}

function single(value: string | string[] | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function presetRange(preset: Exclude<DashboardPeriodPreset, "custom">, today: string): DashboardRange {
  switch (preset) {
    case "today": return { from: today, to: today };
    case "7d": return { from: addDaysISO(today, -6), to: today };
    case "30d": return { from: addDaysISO(today, -29), to: today };
    case "month": return { from: `${today.slice(0, 8)}01`, to: today };
    case "last_month": {
      const lastOfPrevious = addDaysISO(`${today.slice(0, 8)}01`, -1);
      return { from: `${lastOfPrevious.slice(0, 8)}01`, to: lastOfPrevious };
    }
  }
}

export function resolveDashboardPeriod(input: DashboardPeriodInput, now: Date, timeZone: string): DashboardPeriodResolution {
  const today = zonedDayISO(now, timeZone);
  const fallback = build("today", presetRange("today", today), today);
  const fail = (message: string): DashboardPeriodResolution => ({ ok: false, message, period: fallback });

  const rawPreset = single(input.period);
  if (rawPreset === undefined || rawPreset === "") return { ok: true, period: fallback };
  if (rawPreset === null || !(DASHBOARD_PERIOD_PRESETS as readonly string[]).includes(rawPreset)) return fail("Pilihan periode tidak dikenal. Menampilkan hari ini.");
  const preset = rawPreset as DashboardPeriodPreset;
  if (preset !== "custom") return { ok: true, period: build(preset, presetRange(preset, today), today) };

  const from = single(input.from);
  const to = single(input.to);
  if (!isValidDateISO(from) || !isValidDateISO(to)) return fail("Tanggal harus berformat YYYY-MM-DD. Menampilkan hari ini.");
  if (from > to) return fail("Tanggal mulai tidak boleh setelah tanggal akhir. Menampilkan hari ini.");
  if (from > today) return fail("Rentang yang seluruhnya di masa depan tidak dapat ditampilkan. Menampilkan hari ini.");
  if (to > today) return fail("Tanggal akhir tidak boleh melewati hari ini. Menampilkan hari ini.");
  if (inclusiveDays(from, to) > MAX_DASHBOARD_PERIOD_DAYS) return fail(`Rentang maksimal ${MAX_DASHBOARD_PERIOD_DAYS} hari. Menampilkan hari ini.`);
  const period = build("custom", { from, to }, today);
  if (period.previous.from < EARLIEST_DATE) return fail("Rentang terlalu jauh ke belakang untuk dibandingkan. Menampilkan hari ini.");
  return { ok: true, period };
}
