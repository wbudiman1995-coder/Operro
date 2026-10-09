import type { BranchAccess, CapabilityMap } from "@/lib/authorization";
import { addDaysISO, zonedDateTimeToUtc, zonedDayISO } from "@/lib/timezone";

export const DASHBOARD_CARD_KEYS = ["booking_today", "revenue_today", "active_customers", "open_tasks"] as const;
export type DashboardCardKey = (typeof DASHBOARD_CARD_KEYS)[number];
export type DashboardCardVisibility = Record<DashboardCardKey, boolean>;

export const DASHBOARD_CARD_LABELS: Record<DashboardCardKey, string> = {
  booking_today: "Booking hari ini",
  revenue_today: "Pendapatan tercatat",
  active_customers: "Pelanggan aktif",
  open_tasks: "Tugas tertunda",
};

export const DASHBOARD_CARD_DEFAULTS: DashboardCardVisibility = {
  booking_today: true,
  revenue_today: true,
  active_customers: true,
  open_tasks: true,
};

/** Invalid or absent entries retain the legacy all-visible behavior. */
export function readDashboardCardSettings(settings: unknown): DashboardCardVisibility {
  const result = { ...DASHBOARD_CARD_DEFAULTS };
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return result;
  const dashboard = (settings as Record<string, unknown>).dashboard;
  if (!dashboard || typeof dashboard !== "object" || Array.isArray(dashboard)) return result;
  const cards = (dashboard as Record<string, unknown>).cards;
  if (!cards || typeof cards !== "object" || Array.isArray(cards)) return result;
  for (const key of DASHBOARD_CARD_KEYS) {
    const value = (cards as Record<string, unknown>)[key];
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

/** Read domains that the dashboard may query for the current caller. */
export interface DashboardReadPlan {
  bookingMetrics: boolean;
  upcomingBookings: boolean;
  revenueMetrics: boolean;
  customerMetrics: boolean;
  taskMetrics: boolean;
  /** null means every branch; an array is the exact server-resolved grant set. */
  branchIds: string[] | null;
}

export function buildDashboardReadPlan(
  capabilities: CapabilityMap,
  branchAccess: BranchAccess,
  visibility: DashboardCardVisibility = DASHBOARD_CARD_DEFAULTS,
): DashboardReadPlan {
  return {
    bookingMetrics: capabilities["booking.read"] && visibility.booking_today,
    upcomingBookings: capabilities["booking.read"],
    revenueMetrics: capabilities["finance.read"] && visibility.revenue_today,
    customerMetrics: (capabilities["customer.read"] || capabilities["customer.manage"]) && visibility.active_customers,
    taskMetrics: capabilities["task.manage"] && visibility.open_tasks,
    branchIds: branchAccess.all ? null : [...branchAccess.ids].sort(),
  };
}

export interface DashboardDayRanges {
  previousStart: string;
  currentStart: string;
  currentEnd: string;
  upcomingEnd: string;
}

/** Builds branch-local calendar boundaries instead of relying on the server time zone. */
export function dashboardDayRanges(now: Date, timeZone: string): DashboardDayRanges {
  const currentDay = zonedDayISO(now, timeZone);
  const previousDay = addDaysISO(currentDay, -1);
  const nextDay = addDaysISO(currentDay, 1);
  const upcomingDay = addDaysISO(currentDay, 7);
  return {
    previousStart: zonedDateTimeToUtc(previousDay, 0, timeZone).toISOString(),
    currentStart: zonedDateTimeToUtc(currentDay, 0, timeZone).toISOString(),
    currentEnd: zonedDateTimeToUtc(nextDay, 0, timeZone).toISOString(),
    upcomingEnd: zonedDateTimeToUtc(upcomingDay, 0, timeZone).toISOString(),
  };
}

/** Sums only finite, non-negative amounts actually returned by persisted revenue rows. */
export function sumRecordedAmounts(rows: readonly { amount: unknown }[]): number {
  return rows.reduce((sum, row) => {
    const amount = typeof row.amount === "number" || typeof row.amount === "string" ? Number(row.amount) : Number.NaN;
    return Number.isFinite(amount) && amount >= 0 ? sum + amount : sum;
  }, 0);
}

export type ComparisonDirection = "up" | "down" | "same";

export function comparisonDirection(current: number, previous: number): ComparisonDirection {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "same";
}
