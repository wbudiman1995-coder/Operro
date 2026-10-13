/**
 * Function index:
 * - loadProviderState: the owner's provider settings and whether the platform has made a provider available (app.whatsapp_provider_state).
 * - parseProviderState: shapes the database row (pure).
 * - validateProviderForm / describeProviderError: display-only input checks and plain-language error mapping.
 * - PROVIDER_REQUIREMENTS: the setup decisions an owner must take before a provider can be enabled.
 *
 * Migration 20261101120000. The settings hold non-secret numeric identifiers and a consent attestation only. No credential, token or URL is
 * ever collected, and enabling is refused by the database until the platform opens the provider, which nothing in this program does.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const PROVIDERS = ["none", "meta_cloud"] as const;
export type ProviderKey = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<ProviderKey, string> = { none: "Tidak ada (draf manual)", meta_cloud: "Meta WhatsApp Business Cloud API (resmi)" };

export const PROVIDER_REQUIREMENTS = [
  "Akun bisnis Meta yang sudah diverifikasi, nomor WhatsApp Business milik bisnis (bukan nomor pribadi), dan template pesan yang disetujui Meta.",
  "Persetujuan (opt-in) tertulis dari setiap pelanggan yang akan dihubungi, beserta cara berhenti menerima pesan; pelanggan yang menolak sudah dihormati oleh Pusat WhatsApp.",
  "Kredensial penyedia disimpan hanya di penyimpanan rahasia hosting. Operro tidak menyimpan atau menampilkan token atau kunci.",
  "Endpoint webhook dan identitas layanan untuk menerimanya, diputuskan oleh pemilik platform (lihat runbook). Tanpa webhook, status terkirim atau dibaca tidak ada.",
  "Uji coba di lingkungan staging dengan nomor uji, sebelum nomor produksi.",
] as const;

export interface ProviderState {
  platformAvailable: boolean; provider: ProviderKey; phoneNumberId: string | null; businessAccountId: string | null;
  consentAttested: boolean; consentAttestedAt: string | null; enabled: boolean; version: number;
}

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function parseProviderState(data: unknown): ProviderState | null {
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  if (!row || typeof row !== "object") return null;
  const provider = (PROVIDERS as readonly string[]).includes(String(row.provider)) ? (row.provider as ProviderKey) : "none";
  const platformAvailable = row.platform_available === true;
  return {
    platformAvailable, provider, phoneNumberId: str(row.phone_number_id), businessAccountId: str(row.business_account_id),
    consentAttested: row.consent_attested === true, consentAttestedAt: str(row.consent_attested_at),
    // Whatever a row says, "enabled" is only true while the platform allows it.
    enabled: row.enabled === true && platformAvailable, version: Number.isInteger(Number(row.version)) ? Number(row.version) : 0,
  };
}

export async function loadProviderState(supabase: SupabaseClient): Promise<ProviderState | null> {
  const { data, error } = await supabase.schema("app").rpc("whatsapp_provider_state");
  if (error) throw Object.assign(new Error(`whatsapp_provider_state_failed:${error.code ?? ""}`), { code: error.code });
  return parseProviderState(data);
}

export interface ProviderFormInput { provider: string; phoneNumberId: string; businessAccountId: string; consentAttested: boolean; version: string }

export function validateProviderForm(input: ProviderFormInput): { ok: true; version: number } | { ok: false; message: string } {
  if (!(PROVIDERS as readonly string[]).includes(input.provider)) return { ok: false, message: "Penyedia tidak valid." };
  const phone = input.phoneNumberId.trim();
  const waba = input.businessAccountId.trim();
  if ((phone !== "" && !/^[0-9]{5,20}$/.test(phone)) || (waba !== "" && !/^[0-9]{5,20}$/.test(waba))) return { ok: false, message: "ID nomor telepon dan ID akun bisnis hanya berisi angka (5–20 digit). Jangan mengisi token atau kunci di sini." };
  if (input.provider === "none" && (phone !== "" || waba !== "")) return { ok: false, message: "Pilih penyedia sebelum mengisi ID." };
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 0) return { ok: false, message: "Versi tidak valid. Muat ulang halaman." };
  return { ok: true, version };
}

export function describeProviderError(error: { code?: string; message?: string }): string {
  const message = error.message ?? "";
  if (error.code === "42501") return "Hanya pemilik bisnis yang dapat mengubah pengaturan penyedia WhatsApp.";
  if (error.code === "40001" || /stale_settings/.test(message)) return "Pengaturan sudah berubah. Muat ulang halaman, lalu coba lagi.";
  if (/provider_not_available/.test(message)) return "Penyedia resmi belum tersedia: pemilik platform Operro belum membukanya. Pengaturan lain tetap dapat disimpan.";
  if (error.code === "22023") return "Input tidak valid. Periksa penyedia dan ID (hanya angka).";
  return "Pengaturan belum dapat disimpan. Coba lagi.";
}
