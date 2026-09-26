import type { SupabaseClient } from "@supabase/supabase-js";

function relationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}
function relationName(value: unknown, fallback: string): string {
  const name = relationRows(value)[0]?.name;
  return typeof name === "string" ? name : fallback;
}

export type MembershipUrgency = "expired" | "urgent" | "normal" | "canceled";

export interface MembershipPackageRow {
  id: string;
  customerId: string;
  customerName: string;
  petName: string | null;
  packageName: string;
  recurrenceInterval: string;
  status: string;
  urgency: MembershipUrgency;
  sessionsRemaining: number;
  reservedSessions: number;
  availableSessions: number;
  purchasedAt: string;
  activatedAt: string | null;
  expiresAt: string | null;
  renewedAt: string | null;
  renewalCount: number;
  revision: number;
  sourceInvoiceNumber: string | null;
  sourceInvoiceBranchId: string | null;
  isLegacy: boolean;
}

export interface MembershipAdministrationWorkspace {
  rows: MembershipPackageRow[];
  branches: Array<{ id: string; name: string }>;
}

const URGENT_WITHIN_DAYS = 7;

function urgencyOf(status: string, expiresAt: string | null, availableSessions: number): MembershipUrgency {
  if (status === "canceled") return "canceled";
  if (availableSessions <= 0) return "urgent";
  if (!expiresAt) return "normal";
  const daysLeft = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= URGENT_WITHIN_DAYS) return "urgent";
  return "normal";
}

export async function loadMembershipAdministrationWorkspace(supabase: SupabaseClient, organizationId: string): Promise<MembershipAdministrationWorkspace> {
  const [rowsResult, reservedResult, branchesResult] = await Promise.all([
    supabase
      .from("customer_packages")
      .select("id,customer_id,package_id,sessions_remaining,status,purchased_at,activated_at,expires_at,renewed_at,renewal_count,revision,source_invoice_id,customers(display_name),packages(name,recurrence_interval),pets(name),invoices(invoice_number,branch_id)")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("purchased_at", { ascending: false }),
    supabase.from("package_reservations").select("customer_package_id").eq("organization_id", organizationId).eq("status", "reserved"),
    supabase.from("branches").select("id,name").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("name"),
  ]);
  if (rowsResult.error) throw new Error(`membership_admin_packages_failed:${rowsResult.error.message}`);
  if (reservedResult.error) throw new Error(`membership_admin_reservations_failed:${reservedResult.error.message}`);
  if (branchesResult.error) throw new Error(`membership_admin_branches_failed:${branchesResult.error.message}`);

  const reservedByPackage = new Map<string, number>();
  for (const row of reservedResult.data ?? []) reservedByPackage.set(row.customer_package_id, (reservedByPackage.get(row.customer_package_id) ?? 0) + 1);

  const rows = (rowsResult.data ?? []).map((row) => {
    const remaining = Number(row.sessions_remaining) || 0;
    const reserved = reservedByPackage.get(row.id) ?? 0;
    const sourceInvoice = relationRows(row.invoices)[0];
    return {
      id: row.id,
      customerId: row.customer_id,
      customerName: relationName(row.customers, "Pelanggan"),
      petName: relationRows(row.pets)[0]?.name as string | undefined ?? null,
      packageName: relationName(row.packages, "Paket"),
      recurrenceInterval: (relationRows(row.packages)[0]?.recurrence_interval as string | undefined) ?? "none",
      status: row.status,
      urgency: urgencyOf(row.status, row.expires_at, Math.max(0, remaining - reserved)),
      sessionsRemaining: remaining,
      reservedSessions: reserved,
      availableSessions: Math.max(0, remaining - reserved),
      purchasedAt: row.purchased_at,
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      renewedAt: row.renewed_at,
      renewalCount: row.renewal_count,
      revision: row.revision,
      sourceInvoiceNumber: sourceInvoice?.invoice_number as string | undefined ?? null,
      sourceInvoiceBranchId: sourceInvoice?.branch_id as string | undefined ?? null,
      isLegacy: !row.source_invoice_id,
    };
  });
  return { rows, branches: branchesResult.data ?? [] };
}
