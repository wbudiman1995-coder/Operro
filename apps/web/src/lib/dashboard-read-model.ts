import type { BranchAccess, CapabilityMap } from "@/lib/authorization";
import { addDaysISO, zonedDateTimeToUtc, zonedDayISO } from "@/lib/timezone";

/** Read domains that the dashboard may query for the current caller. */
export interface DashboardReadPlan {
  bookings: boolean;
  revenue: boolean;
  customers: boolean;
  tasks: boolean;
  /** null means every branch; an array is the exact server-resolved grant set. */
  branchIds: string[] | null;
}

export function buildDashboardReadPlan(
  capabilities: CapabilityMap,
  branchAccess: BranchAccess,
): DashboardReadPlan {
  return {
    bookings: capabilities["booking.read"],
    revenue: capabilities["finance.read"],
    customers: capabilities["customer.read"] || capabilities["customer.manage"],
    tasks: capabilities["task.manage"],
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
