/**
 * Section 36 — cross-entity audit history, with clearer labels. Reads the
 * existing app.list_audit_events RPC (20260910120000_audit_log_read_api.sql,
 * previously unused by the frontend) which already scopes rows to the
 * caller's active org and one entity. This adds actor-name resolution and
 * an Indonesian action label on top -- no new audit storage or RPC.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeChangedFields, type AuditAction } from "@/lib/audit-diff";

export type { AuditAction };

const ACTION_LABEL: Record<AuditAction, string> = { INSERT: "Dibuat", UPDATE: "Diperbarui", DELETE: "Dihapus" };

export interface AuditEvent {
  id: string;
  action: AuditAction;
  actionLabel: string;
  occurredAt: string;
  actorName: string;
  changedFields: string[];
}

interface AuditEventRpcRow {
  id: string;
  actor_id: string | null;
  action: AuditAction;
  diff: { old?: Record<string, unknown>; new?: Record<string, unknown> } | null;
  occurred_at: string;
}

export async function loadAuditEvents(supabase: SupabaseClient, entityTable: string, entityId: string, limit = 20): Promise<AuditEvent[]> {
  const result = await supabase.schema("app").rpc("list_audit_events", { p_entity_table: entityTable, p_entity_id: entityId, p_limit: limit });
  if (result.error) throw new Error(`audit_events_failed:${result.error.message}`);
  const rows = (result.data ?? []) as AuditEventRpcRow[];

  const actorIds = Array.from(new Set(rows.map((r) => r.actor_id).filter((v): v is string => Boolean(v))));
  const actors = actorIds.length
    ? await supabase.from("users").select("id,full_name,email").in("id", actorIds)
    : { data: [] as Array<{ id: string; full_name: string | null; email: string | null }>, error: null };
  if (actors.error) throw new Error(`audit_events_failed:${actors.error.message}`);
  const actorName = new Map((actors.data ?? []).map((u) => [u.id, u.full_name || u.email || "Pengguna"]));

  return rows.map((row) => {
    const changedFields = computeChangedFields(row.action, row.diff?.old ?? {}, row.diff?.new ?? {});
    return {
      id: row.id,
      action: row.action,
      actionLabel: ACTION_LABEL[row.action] ?? row.action,
      occurredAt: row.occurred_at,
      actorName: row.actor_id ? (actorName.get(row.actor_id) ?? "Pengguna") : "Sistem",
      changedFields,
    };
  });
}
