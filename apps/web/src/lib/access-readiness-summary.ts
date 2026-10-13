/**
 * Function index:
 * - loadAccessReadiness: the platform owner's access readiness summary (app.access_readiness_summary).
 * - parseAccessReadiness: shapes the JSON (pure); unknown flag codes are kept visible, never dropped.
 * - FLAG_INFO: what each fixed flag code means and what to do about it.
 * - describeReadinessError: plain-language error mapping.
 *
 * Migration 20261101150000. Counts and fixed flag codes over existing records only: no e-mail address, token, token hash or user id is
 * ever returned, nothing is created or sent, and it makes no claim about real e-mail delivery (that needs the hosted QC script).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FlagInfo { severity: "attention" | "info"; text: string; action: string }
export const FLAG_INFO: Record<string, FlagInfo> = {
  suspended_workspace: { severity: "info", text: "Workspace ditangguhkan: tidak ada yang dapat masuk atau menerima undangan.", action: "Aktifkan kembali dari panel organisasi bila memang seharusnya aktif." },
  no_active_owner: { severity: "attention", text: "Workspace aktif atau uji coba tanpa pemilik bisnis aktif.", action: "Pastikan ada undangan Pemilik yang valid atau terbitkan yang baru." },
  owner_invitation_pending: { severity: "info", text: "Undangan Pemilik yang valid sedang menunggu diterima.", action: "Tunggu penerima, atau terbitkan ulang bila link hilang (link lama otomatis tidak berlaku)." },
  owner_invitation_expired: { severity: "attention", text: "Undangan Pemilik terakhir kedaluwarsa tanpa diterima.", action: "Terbitkan undangan Pemilik baru." },
  no_owner_invitation: { severity: "attention", text: "Tidak ada pemilik aktif dan belum pernah ada undangan Pemilik.", action: "Terbitkan undangan Pemilik." },
  expired_pending_invitations: { severity: "info", text: "Ada undangan yang kedaluwarsa tanpa diterima atau dicabut.", action: "Tidak berbahaya (link tidak dapat dipakai); terbitkan ulang bila penerimanya masih perlu masuk." },
};

export interface OrganizationReadiness {
  id: string; name: string; slug: string; status: string;
  activeMembers: number; suspendedMembers: number; activeOwners: number;
  pendingInvitations: number; expiredPendingInvitations: number; acceptedInvitations: number; revokedInvitations: number;
  flags: string[];
}
export interface AccessReadiness {
  generatedAt: string | null; truncated: boolean;
  totals: { organizations: number; suspendedWorkspaces: number; withoutActiveOwner: number; pendingInvitations: number; expiredPendingInvitations: number; peopleInSeveralOrganizations: number };
  organizations: OrganizationReadiness[];
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

export function parseAccessReadiness(data: unknown): AccessReadiness | null {
  const root = (Array.isArray(data) ? data[0] : data) as Row | null | undefined;
  if (!root || typeof root !== "object" || !Array.isArray(root.organizations)) return null;
  const totals = (root.totals && typeof root.totals === "object" ? root.totals : {}) as Row;
  return {
    generatedAt: typeof root.generated_at === "string" ? root.generated_at : null,
    truncated: root.truncated === true,
    totals: {
      organizations: num(totals.organizations), suspendedWorkspaces: num(totals.suspended_workspaces), withoutActiveOwner: num(totals.without_active_owner),
      pendingInvitations: num(totals.pending_invitations), expiredPendingInvitations: num(totals.expired_pending_invitations), peopleInSeveralOrganizations: num(totals.people_in_several_organizations),
    },
    organizations: (root.organizations as Row[]).flatMap((row) => {
      if (typeof row?.organization_id !== "string") return [];
      return [{
        id: row.organization_id, name: String(row.name ?? ""), slug: String(row.slug ?? ""), status: String(row.status ?? ""),
        activeMembers: num(row.active_members), suspendedMembers: num(row.suspended_members), activeOwners: num(row.active_owners),
        pendingInvitations: num(row.pending_invitations), expiredPendingInvitations: num(row.expired_pending_invitations),
        acceptedInvitations: num(row.accepted_invitations), revokedInvitations: num(row.revoked_invitations),
        flags: Array.isArray(row.flags) ? row.flags.filter((flag): flag is string => typeof flag === "string") : [],
      }];
    }),
  };
}

export async function loadAccessReadiness(supabase: SupabaseClient): Promise<AccessReadiness | null> {
  const { data, error } = await supabase.schema("app").rpc("access_readiness_summary");
  if (error) throw Object.assign(new Error(`access_readiness_failed:${error.code ?? ""}`), { code: error.code });
  return parseAccessReadiness(data);
}

export function describeReadinessError(error: { code?: string }): string {
  if (error.code === "42501") return "Ringkasan kesiapan akses hanya untuk pemilik platform.";
  if (error.code === "PGRST202" || error.code === "42883") return "Ringkasan kesiapan akses belum tersedia di database yang terhubung (migrasi 20261101150000 belum diterapkan).";
  return "Ringkasan kesiapan akses belum dapat dimuat. Ini bukan tanda semuanya siap: coba muat ulang halaman.";
}
