/**
 * Function index:
 * - SETTINGS_MAP: every business setting HomePaw keeps in its single configuration object, where Operro keeps it today, who may
 *   change it, and whether it is organization-wide, per branch, personal or platform-level. Read-only documentation on screen.
 * - formatMinutes / parseTime / TIME_OPTIONS: quarter-hour helpers for the calendar-hours form.
 * - validateCalendarHours: the same bounds as app.set_branch_calendar_hours (display pre-check; the database repeats it).
 * - loadBranchHours: the branches the caller may configure, with the stored hours and the concurrency token.
 * - describeSettingsError: plain-language mapping of database errors.
 *
 * There is deliberately no generic settings editor: each setting has its own typed, validated, audited write path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { filterAccessibleBranches, type BranchAccess } from "@/lib/authorization";
import { DEFAULT_DAY_END_MINUTES, DEFAULT_DAY_START_MINUTES } from "@/lib/schedule-layout";
import { readConfiguredHours } from "@/lib/schedule";

export type SettingScope = "Organisasi" | "Cabang" | "Pribadi" | "Platform";
export interface SettingRow {
  /** HomePaw configuration key (or the HomePaw setting it corresponds to). */
  homepaw: string;
  label: string;
  scope: SettingScope;
  /** Where it is changed in Operro; null = not configurable (with the reason in `note`). */
  href: string | null;
  who: string;
  note: string;
}

export const SETTINGS_MAP: readonly SettingRow[] = [
  { homepaw: "hours (open/close)", label: "Jam kalender per cabang", scope: "Cabang", href: "/settings/business", who: "Pemilik, atau peran dengan branches.manage pada cabang itu", note: "Baru dapat diubah di halaman ini (sebelumnya hanya dibaca). Hanya mengatur rentang sumbu waktu kalender; booking di luar rentang tetap tampil." },
  { homepaw: "branding, waTplDone/Invoice, waClosing, tnc", label: "Branding, rekening bank, template WhatsApp invoice, syarat membership", scope: "Organisasi", href: "/settings/documents", who: "settings.manage", note: "Sudah ada." },
  { homepaw: "followupDays, waTplFollowup, waTplRenewal", label: "Ambang follow-up dan template pengingat", scope: "Organisasi", href: "/followups", who: "settings.manage", note: "Sudah ada di pengaturan Follow-up." },
  { homepaw: "styleRefTtlDays", label: "Masa simpan foto evidence", scope: "Organisasi", href: "/settings/storage", who: "Pemilik bisnis saja", note: "Sudah ada; hanya berlaku untuk foto baru." },
  { homepaw: "dashCards", label: "Kartu dashboard yang tampil", scope: "Organisasi", href: "/dashboard", who: "settings.manage", note: "Sudah ada, termasuk kartu performa dan peringatan." },
  { homepaw: "autoLog", label: "Catat otomatis kunjungan lewat", scope: "Organisasi", href: "/visits", who: "Sesuai izin Kunjungan", note: "Sudah ada di halaman Kunjungan." },
  { homepaw: "customFields", label: "Isian tambahan pelanggan/hewan", scope: "Organisasi", href: "/settings/custom-fields", who: "settings.manage", note: "Sudah ada." },
  { homepaw: "pricing, tiers, durBase, durAdd, areas", label: "Harga/durasi per ukuran, tipe hewan, area layanan", scope: "Organisasi", href: "/catalog", who: "service.manage / branches.manage", note: "Sudah ada di Layanan & tim." },
  { homepaw: "payPublish, stylingTiers, botakIncentive", label: "Publikasi gaji dan insentif groomer", scope: "Organisasi", href: "/payroll", who: "payroll.manage", note: "Sudah ada di Payroll." },
  { homepaw: "toastMs, language, landing", label: "Preferensi tampilan pribadi", scope: "Pribadi", href: "/settings/preferences", who: "Setiap pengguna (hanya untuk dirinya)", note: "Preferensi pribadi tidak mengubah tampilan pengguna lain. Hanya halaman awal; durasi notifikasi dan bahasa belum ada." },
  { homepaw: "sourceLabels", label: "Daftar label sumber pelanggan (saran)", scope: "Organisasi", href: "/settings/business", who: "Pemilik atau settings.manage", note: "Dapat diubah di halaman ini. Hanya saran di formulir pelanggan dan biaya pemasaran: sumber tetap teks bebas, jadi pelanggan lama dan nilai lain tidak ditolak." },
  { homepaw: "dueDayDefault", label: "Jatuh tempo bawaan invoice baru", scope: "Organisasi", href: "/settings/business", who: "Pemilik atau settings.manage", note: "Dapat diubah di halaman ini. Hanya mengisi tanggal jatuh tempo pada invoice baru (tanggal invoice + N hari); invoice yang sudah ada tidak berubah dan tanggalnya tetap dapat diubah." },
  { homepaw: "(currency)", label: "Mata uang organisasi", scope: "Organisasi", href: null, who: "Operro saat penyiapan", note: "Tidak dapat diubah sendiri: mengubahnya setelah ada invoice dan payroll akan mencampur riwayat." },
  { homepaw: "(billing plan, quota)", label: "Paket langganan, kuota, penagihan platform", scope: "Platform", href: null, who: "Pemilik platform Operro", note: "Bukan pengaturan bisnis; dikelola di panel platform." },
];

export const MIN_SPAN_MINUTES = 120;
export const STEP_MINUTES = 15;

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
/** "HH:MM" -> minutes since midnight, or null. 24:00 is allowed as an end. */
export function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && minutes <= 1440 ? minutes : null;
}
export const TIME_OPTIONS: readonly number[] = Array.from({ length: 24 * 4 + 1 }, (_, index) => index * STEP_MINUTES);

export function validateCalendarHours(start: number | null, end: number | null): { ok: true } | { ok: false; message: string } {
  if (start === null && end === null) return { ok: true };
  if (start === null || end === null) return { ok: false, message: "Isi jam buka dan jam tutup sekaligus, atau kosongkan keduanya untuk memakai bawaan." };
  if (!Number.isInteger(start) || !Number.isInteger(end) || start % STEP_MINUTES !== 0 || end % STEP_MINUTES !== 0) return { ok: false, message: "Jam harus kelipatan 15 menit." };
  if (start < 0 || start > 1320 || end < MIN_SPAN_MINUTES || end > 1440) return { ok: false, message: "Jam buka antara 00:00 dan 22:00; jam tutup antara 02:00 dan 24:00." };
  if (end - start < MIN_SPAN_MINUTES) return { ok: false, message: "Jam tutup minimal 2 jam setelah jam buka." };
  return { ok: true };
}

export interface BranchHours {
  id: string; name: string;
  /** The concurrency token, exactly as the database returned it (microsecond precision matters; never parse it). */
  updatedAt: string;
  storedStart: number | null; storedEnd: number | null;
  effectiveStart: number; effectiveEnd: number;
}

export async function loadBranchHours(supabase: SupabaseClient, organizationId: string, access: BranchAccess): Promise<BranchHours[]> {
  const { data, error } = await supabase.from("branches").select("id,name,settings,updated_at").eq("organization_id", organizationId).eq("status", "active").is("deleted_at", null).order("is_default", { ascending: false }).order("name");
  if (error) throw new Error(`branch_hours_failed:${error.code ?? ""}`);
  const rows = filterAccessibleBranches((data ?? []).map((row) => ({ id: String(row.id), name: String(row.name), settings: row.settings as unknown, updatedAt: String(row.updated_at) })), access);
  return rows.map((row) => {
    const schedule = typeof row.settings === "object" && row.settings !== null ? (row.settings as Record<string, unknown>).schedule : undefined;
    const raw = typeof schedule === "object" && schedule !== null ? (schedule as Record<string, unknown>) : {};
    const start = Number(raw.dayStartMinutes);
    const end = Number(raw.dayEndMinutes);
    const stored = Number.isInteger(start) && Number.isInteger(end) && validateCalendarHours(start, end).ok;
    const effective = readConfiguredHours(row.settings);
    return { id: row.id, name: row.name, updatedAt: row.updatedAt, storedStart: stored ? start : null, storedEnd: stored ? end : null, effectiveStart: effective.dayStartMinutes, effectiveEnd: effective.dayEndMinutes };
  });
}

export const DEFAULT_HOURS = { start: DEFAULT_DAY_START_MINUTES, end: DEFAULT_DAY_END_MINUTES } as const;

export function describeSettingsError(error: { code?: string; message?: string }): string {
  if (error.code === "42501") return "Anda tidak memiliki izin mengubah jam kalender cabang ini (pemilik, atau branches.manage pada cabang tersebut).";
  if (error.code === "40001") return "Pengaturan cabang ini sudah diubah oleh orang lain. Muat ulang halaman, periksa nilainya, lalu simpan lagi.";
  if (error.code === "P0002") return "Cabang tidak ditemukan.";
  if (error.code === "22023") return "Jam tidak valid: kelipatan 15 menit, buka 00:00–22:00, tutup 02:00–24:00, minimal 2 jam.";
  return "Perubahan belum tersimpan. Coba lagi.";
}
