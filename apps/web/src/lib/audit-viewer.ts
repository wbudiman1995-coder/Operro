/**
 * Function index:
 * - AUDIT_ENTITY_LABELS / auditEntityLabel: Indonesian names for audited tables (unknown tables fall back to the raw name).
 * - parseAuditFilters: validates the query string (table, action, actor, from, to, cursor) with business-zone day boundaries.
 * - loadAuditPage: calls app.search_audit_events (capability-, branch- and tenant-aware, redacted) and resolves labels.
 * - summarizeChange: per-field "old -> new" lines for UPDATE events, built from the already-reduced diff.
 *
 * The database decides what a caller may see; nothing here re-implements authorization. Read-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { auditFieldLabel, computeChangedFields, type AuditAction } from "@/lib/audit-diff";
import { addDaysISO, isValidDateISO, zonedDateTimeToUtc } from "@/lib/timezone";

export const AUDIT_PAGE_SIZE = 50;

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  customers: "Pelanggan", pets: "Hewan", customer_addresses: "Alamat pelanggan", custom_field_definitions: "Definisi isian tambahan",
  custom_field_values: "Nilai isian tambahan", bookings: "Booking", grooming_job_pets: "Hewan dalam booking", invoices: "Invoice",
  payments: "Pembayaran", refunds: "Pengembalian dana", expenses: "Pengeluaran", customer_packages: "Paket pelanggan",
  payroll_runs: "Periode payroll", payroll_publications: "Publikasi payroll", manual_visits: "Kunjungan manual",
  visit_manual_billing: "Penagihan manual", whatsapp_drafts: "Draf WhatsApp", whatsapp_contact_preferences: "Preferensi kontak WhatsApp",
  roles: "Peran", memberships: "Anggota tim", role_permissions: "Izin peran", organizations: "Pengaturan bisnis",
  service_catalog: "Layanan", resources: "Sumber daya / groomer", customer_onboarding_links: "Link pendaftaran",
};
export function auditEntityLabel(table: string): string {
  return AUDIT_ENTITY_LABELS[table] ?? table;
}
const ACTION_LABEL: Record<AuditAction, string> = { INSERT: "Dibuat", UPDATE: "Diperbarui", DELETE: "Dihapus" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditFilters {
  table: string | null;
  action: AuditAction | null;
  actor: string | null;
  from: string | null;
  to: string | null;
  cursor: { at: string; id: string } | null;
}
export interface AuditQuery { table?: string; action?: string; actor?: string; from?: string; to?: string; cursor?: string }

export function parseAuditFilters(query: AuditQuery): { ok: true; filters: AuditFilters } | { ok: false; message: string; filters: AuditFilters } {
  const empty: AuditFilters = { table: null, action: null, actor: null, from: null, to: null, cursor: null };
  const filters = { ...empty };
  if (query.table) {
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(query.table)) return { ok: false, message: "Jenis data tidak valid.", filters: empty };
    filters.table = query.table;
  }
  if (query.action) {
    if (query.action !== "INSERT" && query.action !== "UPDATE" && query.action !== "DELETE") return { ok: false, message: "Jenis perubahan tidak valid.", filters: empty };
    filters.action = query.action;
  }
  if (query.actor) {
    if (!UUID.test(query.actor)) return { ok: false, message: "Pengguna tidak valid.", filters: empty };
    filters.actor = query.actor;
  }
  for (const key of ["from", "to"] as const) {
    const value = query[key];
    if (value) {
      if (!isValidDateISO(value)) return { ok: false, message: "Tanggal harus berformat YYYY-MM-DD.", filters: empty };
      filters[key] = value;
    }
  }
  if (filters.from && filters.to && filters.from > filters.to) return { ok: false, message: "Tanggal mulai tidak boleh setelah tanggal akhir.", filters: empty };
  if (query.cursor) {
    const separator = query.cursor.lastIndexOf("_");
    const at = separator > 0 ? query.cursor.slice(0, separator) : "";
    const id = separator > 0 ? query.cursor.slice(separator + 1) : "";
    if (Number.isNaN(Date.parse(at)) || !UUID.test(id)) return { ok: false, message: "Halaman tidak valid.", filters: empty };
    filters.cursor = { at: new Date(at).toISOString(), id };
  }
  return { ok: true, filters };
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorLabel: string;
  action: AuditAction;
  actionLabel: string;
  entityTable: string;
  entityLabel: string;
  entityId: string | null;
  changes: Array<{ field: string; before: string; after: string }>;
  changedFieldLabels: string[];
}
export interface AuditPage { rows: AuditRow[]; hasMore: boolean; nextCursor: string | null }

interface AuditRpcRow {
  id: string; occurred_at: string; actor_id: string | null; actor_label: string; action: AuditAction; entity_table: string; entity_id: string | null;
  diff: { old?: Record<string, unknown>; new?: Record<string, unknown> } | null;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function summarizeChange(action: AuditAction, diff: AuditRpcRow["diff"]): Array<{ field: string; before: string; after: string }> {
  if (action !== "UPDATE") return [];
  const before = diff?.old ?? {};
  const after = diff?.new ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.map((key) => ({ field: auditFieldLabel(key), before: show(before[key]), after: show(after[key]) }));
}

/** Business-zone day boundaries: `to` is inclusive, so the RPC gets the start of the next day. */
export function auditWindow(filters: Pick<AuditFilters, "from" | "to">, timeZone: string): { from: string | null; to: string | null } {
  return {
    from: filters.from ? zonedDateTimeToUtc(filters.from, 0, timeZone).toISOString() : null,
    to: filters.to ? zonedDateTimeToUtc(addDaysISO(filters.to, 1), 0, timeZone).toISOString() : null,
  };
}

export async function loadAuditPage(supabase: SupabaseClient, filters: AuditFilters, timeZone: string, pageSize = AUDIT_PAGE_SIZE): Promise<AuditPage> {
  const window = auditWindow(filters, timeZone);
  const { data, error } = await supabase.schema("app").rpc("search_audit_events", {
    p_tables: filters.table ? [filters.table] : null,
    p_actor: filters.actor,
    p_action: filters.action,
    p_from: window.from,
    p_to: window.to,
    p_cursor_at: filters.cursor?.at ?? null,
    p_cursor_id: filters.cursor?.id ?? null,
    p_limit: pageSize + 1,
  });
  if (error) throw new Error(`audit_search_failed:${error.code ?? ""}:${error.message}`);
  const all = (data ?? []) as AuditRpcRow[];
  const hasMore = all.length > pageSize;
  const page = hasMore ? all.slice(0, pageSize) : all;
  const rows: AuditRow[] = page.map((row) => ({
    id: row.id, occurredAt: row.occurred_at, actorId: row.actor_id, actorLabel: row.actor_label, action: row.action,
    actionLabel: ACTION_LABEL[row.action] ?? row.action, entityTable: row.entity_table, entityLabel: auditEntityLabel(row.entity_table),
    entityId: row.entity_id, changes: summarizeChange(row.action, row.diff),
    changedFieldLabels: computeChangedFields(row.action, row.diff?.old ?? {}, row.diff?.new ?? {}),
  }));
  const last = page[page.length - 1];
  return { rows, hasMore, nextCursor: hasMore && last ? `${last.occurred_at}_${last.id}` : null };
}
