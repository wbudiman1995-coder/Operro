/**
 * Function index:
 * - UNATTENDED_CLEANUP_AVAILABLE: false while the repository has no scheduler and no service identity (verified by a test that
 *   scans for cron routes, vercel crons, pg_cron and service-role use). Flip it only together with a real, reviewed runner.
 * - loadCleanupScheduleState: the owner's recorded consent (app.storage_cleanup_schedule_state); consent only, never a next run.
 * - describeScheduleState: the wording the UI shows, which says so whenever consent exists but no runner does.
 *
 * Turning consent on deletes nothing. Manual, dry-run-first cleanup (storage-cleanup.ts) is the only way files are removed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const UNATTENDED_CLEANUP_AVAILABLE = false;
export const SCHEDULE_CADENCES = ["weekly", "monthly"] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

export interface CleanupScheduleState {
  enabled: boolean;
  cadence: ScheduleCadence;
  changedAt: string | null;
  disabledAt: string | null;
  lastApplyAt: string | null;
  lastApplyStatus: string | null;
}

type Row = Record<string, unknown>;
export function parseScheduleState(data: unknown): CleanupScheduleState | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Row;
  if (typeof row.enabled !== "boolean") return null;
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    enabled: row.enabled, cadence: row.cadence === "monthly" ? "monthly" : "weekly",
    changedAt: str(row.changed_at), disabledAt: str(row.disabled_at), lastApplyAt: str(row.last_apply_at), lastApplyStatus: str(row.last_apply_status),
  };
}

/** null = not the owner, or the feature is not in this database; the panel then says "not shown", never "off". */
export async function loadCleanupScheduleState(supabase: SupabaseClient): Promise<CleanupScheduleState | null> {
  const { data, error } = await supabase.schema("app").rpc("storage_cleanup_schedule_state");
  if (error) {
    if (error.code !== "42501" && error.code !== "PGRST202") console.error("cleanup_schedule_state_failed", { code: error.code });
    return null;
  }
  return parseScheduleState(data);
}

export function describeScheduleState(state: CleanupScheduleState, runnerAvailable: boolean = UNATTENDED_CLEANUP_AVAILABLE): { headline: string; detail: string; tone: "off" | "consent_only" | "active" } {
  if (!state.enabled) {
    return { headline: "Pembersihan otomatis: mati", detail: state.disabledAt ? `Dimatikan ${new Date(state.disabledAt).toLocaleString("id-ID")}. Pembersihan hanya berjalan saat pemilik menjalankannya sendiri setelah pratinjau.` : "Belum pernah diaktifkan. Pembersihan hanya berjalan saat pemilik menjalankannya sendiri setelah pratinjau.", tone: "off" };
  }
  if (!runnerAvailable) {
    return {
      headline: `Persetujuan ${state.cadence === "weekly" ? "mingguan" : "bulanan"} tercatat, tetapi belum ada penjadwal`,
      detail: "Platform ini belum memiliki penjadwal atau identitas layanan, sehingga tidak ada pembersihan otomatis yang berjalan atau akan berjalan dari pengaturan ini. Persetujuan ini hanya dicatat agar penjadwal yang kelak disetujui pemilik platform tidak berjalan tanpa izin Anda. Matikan kapan saja.",
      tone: "consent_only",
    };
  }
  return { headline: `Pembersihan otomatis ${state.cadence === "weekly" ? "mingguan" : "bulanan"} aktif`, detail: "Penjadwal selalu mulai dari pratinjau dan memakai kunci proses yang sama dengan pembersihan manual.", tone: "active" };
}
