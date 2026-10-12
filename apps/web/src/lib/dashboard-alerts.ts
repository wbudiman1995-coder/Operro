/**
 * Function index:
 * - ALERT_DEFINITIONS: for every alert, what it measures, its fixed threshold and the ONE page it links to.
 * - buildAlertReadPlan: which alerts the caller may load; a false entry means NO query is issued for it.
 * - loadOperationalAlerts: runs the permitted alerts independently (one failing or denied alert never hides the others).
 * - parseAlertRows: shapes database rows into display data (pure).
 *
 * Every alert is a count over an existing authoritative record with a fixed threshold (see migration 20261031100000 and
 * app.reconcile_unbilled_visits). None is a score, forecast or ROI. Links point only at pages the same capability already
 * opens. The organization comes from the authenticated session inside the database; this module sends none.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { BranchAccess, CapabilityMap } from "@/lib/authorization";
import { DASHBOARD_CARD_DEFAULTS, type DashboardCardVisibility } from "@/lib/dashboard-read-model";
import { loadUnbilledVisits } from "@/lib/reconciliation";

export const ALERT_KEYS = ["unbilled_visits", "overdue_invoices", "expiring_packages", "stale_open_bookings", "maintenance_problems"] as const;
export type AlertKey = (typeof ALERT_KEYS)[number];
export const UNBILLED_COUNT_CAP = 100;

export interface AlertDefinition { title: string; measures: string; href: string; linkLabel: string; needs: string }

export const ALERT_DEFINITIONS: Record<AlertKey, AlertDefinition> = {
  unbilled_visits: {
    title: "Kunjungan selesai belum ditagih",
    measures: "Kunjungan selesai (booking maupun kunjungan manual) tanpa invoice yang valid dan tanpa penagihan manual. Seluruh riwayat, bukan hanya periode di atas. Dihitung sampai 100.",
    href: "/reconciliation", linkLabel: "Buka rekonsiliasi", needs: "booking.read, finance.read, order.read",
  },
  overdue_invoices: {
    title: "Invoice lewat jatuh tempo",
    measures: "Invoice berstatus terbit yang tanggal jatuh temponya sudah lewat dan totalnya masih melebihi pembayaran berhasil. Jumlah = sisa tagihan, per mata uang. Invoice tanpa tanggal jatuh tempo tidak dihitung.",
    href: "/finance", linkLabel: "Buka keuangan", needs: "finance.read",
  },
  expiring_packages: {
    title: "Paket/membership segera berakhir",
    measures: "Paket pelanggan aktif dengan sisa sesi dan tanggal berakhir dalam 7 hari ke depan. Paket tanpa tanggal berakhir, tanpa sisa sesi, atau sudah berakhir tidak dihitung.",
    href: "/programs/memberships", linkLabel: "Buka membership", needs: "membership.read",
  },
  stale_open_bookings: {
    title: "Booking belum ditutup",
    measures: "Booking berstatus diminta, dikonfirmasi, atau sedang berjalan yang sudah dimulai lebih dari 24 jam lalu (90 hari terakhir). Perlu diselesaikan, dibatalkan, atau ditandai tidak hadir.",
    href: "/schedule", linkLabel: "Buka jadwal", needs: "booking.read",
  },
  maintenance_problems: {
    title: "Pekerjaan pemeliharaan bermasalah",
    measures: "Ekspor organisasi gagal dalam 30 hari atau berjalan lebih dari 2 jam, serta pembersihan penyimpanan yang gagal, sebagian, terhenti dalam 30 hari atau berjalan melewati lease-nya. Hanya pemilik bisnis.",
    href: "/settings/health", linkLabel: "Buka kesehatan & pemulihan", needs: "pemilik bisnis",
  },
};

export type AlertPlan = Record<AlertKey, boolean>;

export function buildAlertReadPlan(
  capabilities: CapabilityMap,
  branchAccess: BranchAccess,
  isBusinessOwner: boolean,
  visibility: DashboardCardVisibility = DASHBOARD_CARD_DEFAULTS,
): AlertPlan {
  const hasBranch = branchAccess.all || branchAccess.ids.size > 0;
  const on = visibility.operational_alerts;
  return {
    unbilled_visits: on && hasBranch && capabilities["booking.read"] && capabilities["finance.read"] && capabilities["order.read"],
    overdue_invoices: on && hasBranch && capabilities["finance.read"],
    expiring_packages: on && capabilities["membership.read"],
    stale_open_bookings: on && hasBranch && capabilities["booking.read"],
    maintenance_problems: on && isBusinessOwner,
  };
}

export interface AlertAmount { currency: string; count: number; amount: number }
export type AlertResult =
  | { key: AlertKey; status: "restricted"; reason: string }
  | { key: AlertKey; status: "unavailable"; reason: string }
  | { key: AlertKey; status: "ready"; count: number; capped: boolean; amounts: AlertAmount[]; oldestAt: string | null };
export type AlertsState = { status: "hidden" } | { status: "ready"; alerts: AlertResult[] };

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Rows of one alert key -> display data. A key with only the explicit zero row yields count 0 and no amounts. */
export function parseAlertRows(key: AlertKey, data: unknown): Extract<AlertResult, { status: "ready" }> {
  const rows = (Array.isArray(data) ? data : []).filter((row): row is Row => typeof row === "object" && row !== null && row.alert_key === key);
  const amounts: AlertAmount[] = [];
  let count = 0;
  let oldest: string | null = null;
  for (const row of rows) {
    const n = num(row.item_count);
    count += n;
    if (typeof row.currency === "string" && row.currency !== "" && n > 0) amounts.push({ currency: row.currency, count: n, amount: num(row.amount) });
    if (n > 0 && typeof row.oldest_at === "string" && (oldest === null || row.oldest_at < oldest)) oldest = row.oldest_at;
  }
  amounts.sort((a, b) => (a.currency === "IDR" ? -1 : b.currency === "IDR" ? 1 : a.currency.localeCompare(b.currency)));
  return { key, status: "ready", count, capped: false, amounts, oldestAt: oldest };
}

const DENIED = "Akses ditolak oleh database untuk peran ini; angka tidak ditampilkan.";
const MISSING = "Fitur ini belum tersedia di database yang terhubung (migrasi 20261031100000 belum diterapkan).";
const FAILED = "Data tidak dapat dimuat saat ini. Coba muat ulang halaman.";

function classify(key: AlertKey, error: { code?: string }): AlertResult {
  if (error.code === "42501") return { key, status: "restricted", reason: DENIED };
  if (error.code === "PGRST202" || error.code === "42883") return { key, status: "unavailable", reason: MISSING };
  console.error(`dashboard_alert_${key}_failed`, { code: error.code });
  return { key, status: "unavailable", reason: FAILED };
}

async function loadOne(supabase: SupabaseClient, key: AlertKey): Promise<AlertResult> {
  try {
    if (key === "unbilled_visits") {
      const page = await loadUnbilledVisits(supabase, null, UNBILLED_COUNT_CAP);
      return { key, status: "ready", count: page.rows.length, capped: page.hasMore, amounts: [], oldestAt: null };
    }
    const { data, error } = await supabase.schema("app").rpc("dashboard_operational_alerts", { p_keys: [key] });
    if (error) return classify(key, error);
    return parseAlertRows(key, data);
  } catch (cause) {
    // loadUnbilledVisits throws "reconcile_visits_failed:<code>:<message>"; keep only the code.
    const code = cause instanceof Error ? /^reconcile_visits_failed:([0-9A-Z]*):/.exec(cause.message)?.[1] : undefined;
    return classify(key, { code });
  }
}

export async function loadOperationalAlerts(
  supabase: SupabaseClient,
  capabilities: CapabilityMap,
  branchAccess: BranchAccess,
  isBusinessOwner: boolean,
  visibility: DashboardCardVisibility = DASHBOARD_CARD_DEFAULTS,
): Promise<AlertsState> {
  if (!visibility.operational_alerts) return { status: "hidden" };
  const plan = buildAlertReadPlan(capabilities, branchAccess, isBusinessOwner, visibility);
  const alerts = await Promise.all(ALERT_KEYS.map((key): Promise<AlertResult> => plan[key]
    ? loadOne(supabase, key)
    : Promise.resolve({ key, status: "restricted", reason: `Peran ini tidak memiliki izin yang dibutuhkan (${ALERT_DEFINITIONS[key].needs}) atau cabang; tidak dimuat.` })));
  return { status: "ready", alerts };
}
