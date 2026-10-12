"use server";

import { revalidatePath } from "next/cache";

import { BATCH_LIMIT, canBatchSource, isBatchSource, type BatchSourceType } from "@/lib/whatsapp-batches";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { buildDraftMessage } from "@/lib/whatsapp-message-build";

/**
 * Batch drafting for invoice / follow-up / renewal sources. The browser sends a source type and source ids only: the
 * message text is built here from stored templates and live data, the recipient phone is derived by the database from the
 * customer row, and eligibility (opt-out, archived, no phone, duplicate live draft) is decided by the database. Nothing is
 * sent anywhere; the outcome of each draft is what a person later reports.
 */
export interface BatchPreviewItem { sourceId: string; eligible: boolean; reason: string | null; label: string | null; text: string | null; existingDraftId: string | null }
export interface BatchOutcomeItem { sourceId: string; outcome: "created" | "existing" | "skipped"; reason: string | null; draftId: string | null }
export interface BatchPreviewState { error: string | null; success: string | null; items: BatchPreviewItem[] | null }
export interface BatchCreateState { error: string | null; success: string | null; batchId: string | null; items: BatchOutcomeItem[] | null }
export interface BatchCancelState { error: string | null; success: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONCURRENCY = 4;

function readSelection(formData: FormData): { ok: true; source: BatchSourceType; ids: string[] } | { ok: false; error: string } {
  const sources = formData.getAll("sourceType");
  const source = sources.length === 1 ? sources[0] : null;
  if (!isBatchSource(source)) return { ok: false, error: "Jenis sumber tidak valid." };
  const raw = formData.getAll("sourceId").filter((value): value is string => typeof value === "string");
  const ids = [...new Set(raw.map((value) => value.trim()))];
  if (ids.length === 0) return { ok: false, error: "Pilih setidaknya satu sumber." };
  if (ids.length > BATCH_LIMIT) return { ok: false, error: `Maksimal ${BATCH_LIMIT} sumber per batch.` };
  if (!ids.every((id) => UUID.test(id))) return { ok: false, error: "Ada sumber dengan ID tidak valid." };
  return { ok: true, source, ids };
}

async function mapLimited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]); }
  }));
  return results;
}

function describeBatchError(error: { code?: string; message?: string }): string {
  if (error.code === "42501") return "Anda tidak memiliki izin untuk sumber pesan ini.";
  if (error.code === "22023") return "Batch tidak valid (maksimal 25 sumber, hanya invoice, follow-up, atau perpanjangan).";
  if (error.code === "P0002") return "Batch tidak ditemukan atau di luar akses Anda.";
  return "Batch belum dapat diproses. Coba lagi.";
}

export async function previewWhatsAppBatchAction(_previous: BatchPreviewState, formData: FormData): Promise<BatchPreviewState> {
  try {
    const workspace = await requireActiveWorkspace();
    const selection = readSelection(formData);
    if (!selection.ok) return { error: selection.error, success: null, items: null };
    if (!canBatchSource(selection.source, workspace.capabilities)) return { error: "Anda tidak memiliki izin untuk sumber ini.", success: null, items: null };
    const { data, error } = await workspace.supabase.schema("app").rpc("preview_whatsapp_batch", { p_source_type: selection.source, p_source_ids: selection.ids });
    if (error) {
      console.error("whatsapp_batch_preview_failed", { code: error.code });
      return { error: describeBatchError(error), success: null, items: null };
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{ source_id: string; eligible: boolean; reason: string | null; existing_draft_id: string | null }>;
    const items = await mapLimited(rows, async (row): Promise<BatchPreviewItem> => {
      if (!row.eligible) return { sourceId: row.source_id, eligible: false, reason: row.reason, label: null, text: null, existingDraftId: row.existing_draft_id };
      const built = await buildDraftMessage(workspace, selection.source, row.source_id);
      return built.ok
        ? { sourceId: row.source_id, eligible: true, reason: null, label: built.label, text: built.text, existingDraftId: null }
        : { sourceId: row.source_id, eligible: false, reason: "invalid_message", label: null, text: built.error, existingDraftId: null };
    });
    const eligible = items.filter((item) => item.eligible).length;
    return { error: null, success: `${eligible} dari ${items.length} sumber siap dibuat sebagai draf. Pratinjau ini tidak menyimpan atau mengirim apa pun.`, items };
  } catch (error) {
    console.error("whatsapp_batch_preview_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Pratinjau belum dapat dibuat. Coba lagi.", success: null, items: null };
  }
}

export async function createWhatsAppBatchAction(_previous: BatchCreateState, formData: FormData): Promise<BatchCreateState> {
  try {
    const workspace = await requireActiveWorkspace();
    const selection = readSelection(formData);
    if (!selection.ok) return { error: selection.error, success: null, batchId: null, items: null };
    if (!canBatchSource(selection.source, workspace.capabilities)) return { error: "Anda tidak memiliki izin untuk sumber ini.", success: null, batchId: null, items: null };
    const built = await mapLimited(selection.ids, async (id) => ({ id, message: await buildDraftMessage(workspace, selection.source, id) }));
    // A source whose message cannot be built is sent with an empty text: the database skips it as invalid_message, so the
    // outcome list still accounts for every selected source.
    const payload = built.map(({ id, message }) => ({ source_id: id, message: message.ok ? message.text : "" }));
    const { data, error } = await workspace.supabase.schema("app").rpc("create_whatsapp_batch", { p_source_type: selection.source, p_items: payload });
    if (error) {
      console.error("whatsapp_batch_create_failed", { code: error.code });
      return { error: describeBatchError(error), success: null, batchId: null, items: null };
    }
    const result = (data ?? {}) as { batch_id?: string | null; created?: number; existing?: number; skipped?: number; results?: Array<{ source_id?: string; outcome?: string; reason?: string; draft_id?: string }> };
    const items: BatchOutcomeItem[] = (result.results ?? []).flatMap((item) => (
      typeof item.source_id === "string" && (item.outcome === "created" || item.outcome === "existing" || item.outcome === "skipped")
        ? [{ sourceId: item.source_id, outcome: item.outcome, reason: item.reason ?? null, draftId: item.draft_id ?? null }] : []));
    revalidatePath("/whatsapp"); revalidatePath("/whatsapp/batches");
    const summary = `${result.created ?? 0} draf dibuat, ${result.existing ?? 0} sudah ada di antrean, ${result.skipped ?? 0} dilewati. Belum ada pesan yang dikirim.`;
    return { error: null, success: summary, batchId: typeof result.batch_id === "string" ? result.batch_id : null, items };
  } catch (error) {
    console.error("whatsapp_batch_create_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Batch belum dapat dibuat. Coba lagi.", success: null, batchId: null, items: null };
  }
}

export async function cancelWhatsAppBatchAction(_previous: BatchCancelState, formData: FormData): Promise<BatchCancelState> {
  try {
    const workspace = await requireActiveWorkspace();
    const ids = formData.getAll("batchId");
    const batchId = ids.length === 1 && typeof ids[0] === "string" ? ids[0] : "";
    if (!UUID.test(batchId)) return { error: "Batch tidak valid.", success: null };
    const { data, error } = await workspace.supabase.schema("app").rpc("cancel_whatsapp_batch", { p_batch: batchId });
    if (error) {
      console.error("whatsapp_batch_cancel_failed", { code: error.code });
      return { error: describeBatchError(error), success: null };
    }
    revalidatePath("/whatsapp"); revalidatePath("/whatsapp/batches"); revalidatePath(`/whatsapp/batches/${batchId}`);
    const n = Number(data) || 0;
    return { error: null, success: n > 0 ? `${n} draf aktif dibatalkan. Draf yang sudah ditandai terkirim tidak diubah.` : "Tidak ada draf aktif yang perlu dibatalkan." };
  } catch (error) {
    console.error("whatsapp_batch_cancel_unexpected", error instanceof Error ? error.message : "unknown");
    return { error: "Batch belum dapat dibatalkan. Coba lagi.", success: null };
  }
}
