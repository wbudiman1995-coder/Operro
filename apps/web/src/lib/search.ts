/**
 * Function index:
 * - normalizeSearchTerm: trims and length-guards an untrusted query string.
 * - escapeLikePattern: neutralizes LIKE wildcards so user input cannot widen the match.
 * - mergeHitsById: deduplicates hits produced by more than one bounded query.
 * - runGlobalSearch: executes bounded organization-scoped lookups across four entities.
 *
 * Filter safety: user input is never composed into PostgREST's `.or()` string. `.or()`
 * takes raw filter syntax, where commas separate terms and parentheses group them, so a
 * term containing `,` `(` `)` or quoting characters changes the filter's structure even
 * after LIKE metacharacters are escaped. Customer name and phone are therefore queried
 * separately with `.ilike()`, which passes the pattern as a single bound value, and the
 * two result sets are merged here.
 *
 * Scaling limitation (accepted for the pilot): there is no trigram or full-text index in
 * the frozen schema, so these are `ilike '%term%'` scans, bounded by a hard per-group
 * limit and a minimum term length. At larger volume this needs an index migration, which
 * is out of scope while migrations are frozen.
 *
 * Permissions: booking and invoice groups are omitted unless the caller holds
 * `booking.read` / `finance.read`. RLS would return them empty anyway, and an empty group
 * reads as "no results" rather than "not permitted".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CapabilityMap } from "@/lib/authorization";
import { formatZonedDate } from "@/lib/timezone";

export const SEARCH_MIN_TERM_LENGTH = 2;
export const SEARCH_MAX_TERM_LENGTH = 64;
export const SEARCH_GROUP_LIMIT = 6;

export type SearchGroupKey = "customers" | "pets" | "bookings" | "invoices";

export interface SearchHit {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

export interface SearchGroup {
  key: SearchGroupKey;
  label: string;
  hits: SearchHit[];
}

export interface SearchOutcome {
  term: string;
  groups: SearchGroup[];
  total: number;
  /** Groups withheld because the caller lacks the permission, for honest UI messaging. */
  restrictedGroups: SearchGroupKey[];
}

export function normalizeSearchTerm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, SEARCH_MAX_TERM_LENGTH);
  return trimmed.length >= SEARCH_MIN_TERM_LENGTH ? trimmed : null;
}

/**
 * PostgREST passes the pattern through to LIKE, so an unescaped `%` would match every
 * row and an unescaped `_` would match any single character.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function mergeHitsById(...groups: readonly SearchHit[][]): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const group of groups) {
    for (const hit of group) if (!seen.has(hit.id)) seen.set(hit.id, hit);
  }
  return [...seen.values()];
}

function relationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
}

function embeddedName(value: unknown, key: string, fallback: string) {
  const name = relationRows(value)[0]?.[key];
  return typeof name === "string" && name.length > 0 ? name : fallback;
}

function fail(scope: string, error: { message: string } | null) {
  if (error) throw new Error(`${scope}_failed:${error.message}`);
}

export async function runGlobalSearch(
  supabase: SupabaseClient,
  organizationId: string,
  rawTerm: unknown,
  capabilities: CapabilityMap,
  branchTimezones: ReadonlyMap<string, string>,
  fallbackTimezone: string,
): Promise<SearchOutcome | null> {
  const term = normalizeSearchTerm(rawTerm);
  if (!term) return null;
  const pattern = `%${escapeLikePattern(term)}%`;
  const restrictedGroups: SearchGroupKey[] = [];
  if (!capabilities["booking.read"]) restrictedGroups.push("bookings");
  if (!capabilities["finance.read"]) restrictedGroups.push("invoices");

  const customerBase = () =>
    supabase.from("customers").select("id,display_name,phone").eq("organization_id", organizationId).is("deleted_at", null);

  const [customersByName, customersByPhone, pets, bookings, invoices] = await Promise.all([
    customerBase().ilike("display_name", pattern).order("display_name").limit(SEARCH_GROUP_LIMIT),
    customerBase().ilike("phone", pattern).order("display_name").limit(SEARCH_GROUP_LIMIT),
    supabase
      .from("pets")
      .select("id,name,breed,customer_id,customers!inner(display_name)")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .ilike("name", pattern)
      .order("name")
      .limit(SEARCH_GROUP_LIMIT),
    capabilities["booking.read"]
      ? supabase
          .from("bookings")
          .select("id,starts_at,status,branch_id,customer_id,customers!inner(display_name)")
          .eq("organization_id", organizationId)
          .is("deleted_at", null)
          .ilike("customers.display_name", pattern)
          .order("starts_at", { ascending: false })
          .limit(SEARCH_GROUP_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    capabilities["finance.read"]
      ? supabase
          .from("invoices")
          .select("id,invoice_number,status,total,currency,customer_id")
          .eq("organization_id", organizationId)
          .ilike("invoice_number", pattern)
          .order("issued_at", { ascending: false })
          .limit(SEARCH_GROUP_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ]);

  fail("search_customers_name", customersByName.error);
  fail("search_customers_phone", customersByPhone.error);
  fail("search_pets", pets.error);
  fail("search_bookings", bookings.error);
  fail("search_invoices", invoices.error);

  const toCustomerHit = (row: { id: string; display_name: string; phone: string | null }): SearchHit => ({
    id: row.id,
    title: row.display_name,
    subtitle: row.phone ?? null,
    href: `/customers/${row.id}`,
  });

  const customerHits = mergeHitsById(
    (customersByName.data ?? []).map(toCustomerHit),
    (customersByPhone.data ?? []).map(toCustomerHit),
  ).slice(0, SEARCH_GROUP_LIMIT);

  const allGroups: SearchGroup[] = [
    { key: "customers", label: "Pelanggan", hits: customerHits },
    {
      key: "pets",
      label: "Hewan",
      hits: (pets.data ?? []).map((row) => ({
        id: row.id,
        title: row.name,
        subtitle: `${embeddedName(row.customers, "display_name", "Pelanggan")}${row.breed ? ` · ${row.breed}` : ""}`,
        href: `/customers/${row.customer_id}?pet=${row.id}`,
      })),
    },
    {
      key: "bookings",
      label: "Booking",
      hits: (bookings.data ?? []).map((row) => ({
        id: row.id,
        title: embeddedName(row.customers, "display_name", "Pelanggan"),
        // Rendered in the booking's own branch time zone, never the server's.
        subtitle: `${formatZonedDate(row.starts_at, branchTimezones.get(row.branch_id) ?? fallbackTimezone)} · ${row.status}`,
        href: `/customers/${row.customer_id}?tab=bookings`,
      })),
    },
    {
      key: "invoices",
      label: "Invoice",
      hits: (invoices.data ?? []).map((row) => ({
        id: row.id,
        title: row.invoice_number,
        subtitle: `${row.status} · ${new Intl.NumberFormat("id-ID", { style: "currency", currency: row.currency || "IDR", maximumFractionDigits: 0 }).format(Number(row.total))}`,
        href: row.customer_id ? `/customers/${row.customer_id}?tab=invoices` : "/finance",
      })),
    },
  ];

  const groups = allGroups.filter((group) => group.hits.length > 0);
  return { term, groups, total: groups.reduce((sum, group) => sum + group.hits.length, 0), restrictedGroups };
}
