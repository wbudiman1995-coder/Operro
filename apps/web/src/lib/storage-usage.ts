import type { SupabaseClient } from "@supabase/supabase-js";

export interface StorageUsage {
  organizationFileBytes: number;
  organizationFileCount: number;
  isPlatformAdmin: boolean;
  projectFileBytes: number | null;
  projectFileCount: number | null;
  projectDatabaseBytes: number | null;
  measuredAt: string;
}

export const SUPABASE_FREE_DATABASE_BYTES = 500 * 1_000_000;
export const SUPABASE_FREE_FILE_BYTES = 1_000_000_000;

export function formatBytes(bytes: number) {
  if (bytes < 1_000_000) return `${(bytes / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`;
  return `${(bytes / 1_000_000_000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} GB`;
}

export async function loadStorageUsage(supabase: SupabaseClient): Promise<StorageUsage | null> {
  const { data, error } = await supabase.schema("app").rpc("storage_usage_snapshot");
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const numeric = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return {
    organizationFileBytes: Number(row.organization_file_bytes ?? 0),
    organizationFileCount: Number(row.organization_file_count ?? 0),
    isPlatformAdmin: row.is_platform_admin === true,
    projectFileBytes: numeric(row.project_file_bytes),
    projectFileCount: numeric(row.project_file_count),
    projectDatabaseBytes: numeric(row.project_database_bytes),
    measuredAt: String(row.measured_at ?? ""),
  };
}
