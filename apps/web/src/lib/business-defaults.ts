/**
 * Function index:
 * - loadBusinessDefaults: the organization's typed defaults (RLS decides visibility); an absent row is "no defaults".
 * - loadSourceSuggestions: the labels for a form's suggestion list; any failure yields no suggestions and never blocks the form.
 * - parseBusinessDefaults / parseLabelsText: shape database rows and the owner's one-label-per-line text (pure).
 * - validateDefaultsForm / describeDefaultsError: display-only input checks and plain-language error mapping.
 * - dueDateFor: the pre-filled due date of a NEW invoice (issue date + the default period, else the day after).
 *
 * Migration 20261101140000. Source labels are SUGGESTIONS: customer source stays free text and nothing refuses another value. The due
 * period only pre-fills a new invoice's due date; it never changes an existing invoice and the date stays editable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { addDaysISO } from "@/lib/timezone";

export const MAX_SOURCE_LABELS = 20;
export const MAX_LABEL_LENGTH = 40;
export const MAX_DUE_DAYS = 365;
export const SOURCE_SUGGESTION_LIST_ID = "source-label-suggestions";

export interface BusinessDefaults { sourceLabels: string[]; invoiceDueDays: number | null; version: number }
export const NO_DEFAULTS: BusinessDefaults = { sourceLabels: [], invoiceDueDays: null, version: 0 };

type Row = Record<string, unknown>;

export function parseBusinessDefaults(data: unknown): BusinessDefaults {
  const row = (Array.isArray(data) ? data[0] : data) as Row | null | undefined;
  if (!row || typeof row !== "object") return NO_DEFAULTS;
  const labels = Array.isArray(row.source_labels) ? row.source_labels.filter((label): label is string => typeof label === "string" && label !== "") : [];
  const days = row.invoice_due_days === null || row.invoice_due_days === undefined ? null : Number(row.invoice_due_days);
  const version = Number(row.version);
  return {
    sourceLabels: labels.slice(0, MAX_SOURCE_LABELS),
    invoiceDueDays: days !== null && Number.isInteger(days) && days >= 0 && days <= MAX_DUE_DAYS ? days : null,
    version: Number.isInteger(version) && version > 0 ? version : 0,
  };
}

export async function loadBusinessDefaults(supabase: SupabaseClient): Promise<BusinessDefaults> {
  const { data, error } = await supabase.from("organization_business_defaults").select("source_labels,invoice_due_days,version").limit(1);
  if (error) throw Object.assign(new Error(`business_defaults_failed:${error.code ?? ""}`), { code: error.code });
  return parseBusinessDefaults(data);
}

/** Suggestions are a convenience: a missing table (older database), a denied read or an error all mean "no suggestions". */
export async function loadSourceSuggestions(supabase: SupabaseClient): Promise<string[]> {
  try {
    return (await loadBusinessDefaults(supabase)).sourceLabels;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code !== "42P01" && code !== "PGRST205") console.error("source_suggestions_failed", { code });
    return [];
  }
}

/** One label per line; spaces are collapsed and blank lines dropped (the database applies the same normalization). */
export function parseLabelsText(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, " ")).filter((line) => line !== "");
}

export interface DefaultsFormInput { labelsText: string; dueDays: string; version: string }

export function validateDefaultsForm(input: DefaultsFormInput): { ok: true; labels: string[]; dueDays: number | null; version: number } | { ok: false; message: string } {
  const labels = parseLabelsText(input.labelsText);
  if (labels.length > MAX_SOURCE_LABELS) return { ok: false, message: `Maksimal ${MAX_SOURCE_LABELS} label sumber.` };
  const seen = new Set<string>();
  for (const label of labels) {
    if (label.length > MAX_LABEL_LENGTH) return { ok: false, message: `Setiap label maksimal ${MAX_LABEL_LENGTH} karakter: “${label.slice(0, 20)}…”.` };
    if (/[\u0000-\u001f]/.test(label)) return { ok: false, message: "Label tidak boleh berisi karakter kontrol." };
    const key = label.toLowerCase();
    if (seen.has(key)) return { ok: false, message: `Label “${label}” muncul dua kali (huruf besar/kecil tidak dibedakan).` };
    seen.add(key);
  }
  const rawDays = input.dueDays.trim();
  let dueDays: number | null = null;
  if (rawDays !== "") {
    if (!/^\d{1,3}$/.test(rawDays) || Number(rawDays) > MAX_DUE_DAYS) return { ok: false, message: `Jatuh tempo bawaan berupa angka 0–${MAX_DUE_DAYS} hari, atau kosongkan untuk memakai bawaan Operro (hari berikutnya).` };
    dueDays = Number(rawDays);
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 0) return { ok: false, message: "Versi tidak valid. Muat ulang halaman." };
  return { ok: true, labels, dueDays, version };
}

export function describeDefaultsError(error: { code?: string; message?: string }): string {
  const message = error.message ?? "";
  if (error.code === "42501") return "Anda tidak memiliki izin mengubah bawaan bisnis (pemilik bisnis atau settings.manage).";
  if (error.code === "40001" || /stale_defaults/.test(message)) return "Bawaan sudah diubah orang lain. Muat ulang halaman, lalu coba lagi.";
  if (/invalid_source_labels/.test(message)) return "Label sumber tidak valid: maksimal 20 label, 40 karakter, tanpa duplikat (huruf besar/kecil tidak dibedakan).";
  if (error.code === "22023") return "Input tidak valid. Periksa label sumber dan jumlah hari.";
  return "Bawaan belum dapat disimpan. Coba lagi.";
}

/** The pre-filled due date of a new invoice: the issue date plus the default period, or the day after when none is set. */
export function dueDateFor(issueDate: string, dueDays: number | null): string {
  return addDaysISO(issueDate, dueDays === null ? 1 : dueDays);
}
