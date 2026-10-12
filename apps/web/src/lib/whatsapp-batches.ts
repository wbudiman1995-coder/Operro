/**
 * Function index:
 * - BATCH_LIMIT / SKIP_REASON_LABELS: bounds and plain-language wording for why a source was not drafted.
 * - loadBatches / loadBatch: RLS-scoped, keyset-paginated batch history.
 * - loadDraftEvents: the append-only delivery log (who/when/from -> to/note) for a set of drafts.
 * - summarizeStatuses: counts of a batch's drafts per user-reported status (pure).
 * - canBatchSource: which sources a caller's capabilities allow.
 *
 * A batch is a group of wa.me DRAFTS created together. Nothing is sent: every status after "draft" is what a person
 * reported (migration 20261031120000), and "delivered"/"read" do not exist anywhere in this contract.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CapabilityMap } from "@/lib/authorization";
import { WHATSAPP_STATUSES, type WhatsAppStatus } from "@/lib/whatsapp-drafts";

export const BATCH_LIMIT = 25;
export const BATCH_PAGE_SIZE = 20;
export const BATCH_SOURCES = ["invoice", "followup", "renewal"] as const;
export type BatchSourceType = (typeof BATCH_SOURCES)[number];

export const SKIP_REASON_LABELS: Record<string, string> = {
  already_in_queue: "Sudah ada draf aktif untuk sumber ini (tidak diubah)",
  duplicate_in_request: "Dipilih dua kali dalam permintaan ini",
  invalid_item: "Data item tidak valid",
  invalid_message: "Isi pesan tidak valid atau masih memuat variabel yang belum terisi",
  recipient_opted_out: "Pelanggan berhenti menerima pesan WhatsApp",
  recipient_phone_missing: "Nomor WhatsApp tidak tersedia atau tidak valid",
  source_archived: "Pelanggan sudah diarsipkan",
  source_not_found: "Sumber tidak ditemukan atau tidak lagi memenuhi syarat",
};
export function describeSkipReason(reason: string | null | undefined): string {
  return (reason && SKIP_REASON_LABELS[reason]) || "Tidak dapat dibuat";
}

export function isBatchSource(value: unknown): value is BatchSourceType {
  return typeof value === "string" && (BATCH_SOURCES as readonly string[]).includes(value);
}

/** Same per-source capability the database applies (app.whatsapp_source_permitted); onboarding is never batched. */
export function canBatchSource(source: BatchSourceType, capabilities: CapabilityMap): boolean {
  return source === "invoice" ? capabilities["finance.read"] : source === "followup" ? capabilities["customer.read"] : capabilities["membership.read"];
}

export interface BatchRow {
  id: string; sourceType: BatchSourceType; status: "open" | "canceled";
  draftCount: number; existingCount: number; skippedCount: number; canceledCount: number;
  createdAt: string; createdBy: string | null; canceledAt: string | null; canceledBy: string | null;
}
export interface BatchCursor { createdAt: string; id: string }
export interface BatchPage { rows: BatchRow[]; hasMore: boolean; nextCursor: BatchCursor | null }

type Row = Record<string, unknown>;
const COLUMNS = "id,source_type,status,draft_count,existing_count,skipped_count,canceled_count,created_by,created_at,canceled_by,canceled_at";

async function actorNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("users").select("id,full_name,email").in("id", ids);
  if (error) throw new Error(`whatsapp_actors_failed:${error.code ?? ""}`);
  return new Map((data ?? []).map((row: Row) => [String(row.id), String(row.full_name || row.email || "Pengguna")]));
}

function toBatch(row: Row, names: Map<string, string>): BatchRow {
  const by = (value: unknown) => (typeof value === "string" ? names.get(value) ?? null : null);
  return {
    id: String(row.id), sourceType: row.source_type as BatchSourceType, status: row.status === "canceled" ? "canceled" : "open",
    draftCount: Number(row.draft_count), existingCount: Number(row.existing_count), skippedCount: Number(row.skipped_count), canceledCount: Number(row.canceled_count),
    createdAt: String(row.created_at), createdBy: by(row.created_by), canceledAt: typeof row.canceled_at === "string" ? row.canceled_at : null, canceledBy: by(row.canceled_by),
  };
}

export async function loadBatches(supabase: SupabaseClient, organizationId: string, cursor: BatchCursor | null = null, pageSize = BATCH_PAGE_SIZE): Promise<BatchPage> {
  const size = Math.max(1, Math.min(pageSize, 100));
  let query = supabase.from("whatsapp_batches").select(COLUMNS).eq("organization_id", organizationId)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(size + 1);
  if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw new Error(`whatsapp_batches_failed:${error.code ?? ""}`);
  const all = (data ?? []) as Row[];
  const hasMore = all.length > size;
  const page = hasMore ? all.slice(0, size) : all;
  const names = await actorNames(supabase, [...new Set(page.flatMap((row) => [row.created_by, row.canceled_by].filter((v): v is string => typeof v === "string")))]);
  const rows = page.map((row) => toBatch(row, names));
  const last = rows[rows.length - 1];
  return { rows, hasMore, nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null };
}

export async function loadBatch(supabase: SupabaseClient, organizationId: string, id: string): Promise<BatchRow | null> {
  const { data, error } = await supabase.from("whatsapp_batches").select(COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle();
  if (error) throw new Error(`whatsapp_batch_failed:${error.code ?? ""}`);
  if (!data) return null;
  const row = data as Row;
  return toBatch(row, await actorNames(supabase, [row.created_by, row.canceled_by].filter((v): v is string => typeof v === "string")));
}

export interface DraftEvent { id: string; draftId: string; from: WhatsAppStatus | null; to: WhatsAppStatus; note: string | null; actor: string | null; occurredAt: string }

/** Events of the given drafts, oldest first. At most 100 drafts per call (a page). */
export async function loadDraftEvents(supabase: SupabaseClient, organizationId: string, draftIds: readonly string[]): Promise<Map<string, DraftEvent[]>> {
  const result = new Map<string, DraftEvent[]>();
  if (draftIds.length === 0) return result;
  if (draftIds.length > 100) throw new Error("whatsapp_events_too_many_drafts");
  const { data, error } = await supabase.from("whatsapp_draft_events")
    .select("id,draft_id,from_status,to_status,note,actor_id,occurred_at").eq("organization_id", organizationId).in("draft_id", draftIds)
    .order("occurred_at", { ascending: true }).order("id", { ascending: true }).limit(1000);
  if (error) throw new Error(`whatsapp_events_failed:${error.code ?? ""}`);
  const rows = (data ?? []) as Row[];
  const names = await actorNames(supabase, [...new Set(rows.flatMap((row) => (typeof row.actor_id === "string" ? [row.actor_id] : [])))]);
  const valid = (value: unknown): WhatsAppStatus | null => (typeof value === "string" && (WHATSAPP_STATUSES as readonly string[]).includes(value) ? (value as WhatsAppStatus) : null);
  for (const row of rows) {
    const to = valid(row.to_status);
    if (!to) continue;
    const draftId = String(row.draft_id);
    const list = result.get(draftId) ?? [];
    list.push({ id: String(row.id), draftId, from: valid(row.from_status), to, note: typeof row.note === "string" ? row.note : null, actor: typeof row.actor_id === "string" ? names.get(row.actor_id) ?? null : null, occurredAt: String(row.occurred_at) });
    result.set(draftId, list);
  }
  return result;
}

export function summarizeStatuses(drafts: ReadonlyArray<{ status: WhatsAppStatus }>): Record<WhatsAppStatus, number> {
  const counts = Object.fromEntries(WHATSAPP_STATUSES.map((status) => [status, 0])) as Record<WhatsAppStatus, number>;
  for (const draft of drafts) counts[draft.status] += 1;
  return counts;
}
