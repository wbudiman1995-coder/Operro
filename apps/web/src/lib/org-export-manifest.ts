import { createHash } from "node:crypto";

export const ORG_EXPORT_FORMAT = "operro-organization-export" as const;
export const ORG_EXPORT_VERSION = 1 as const;
export const ORG_EXPORT_STORAGE_BUCKETS = ["attachments", "styling-references", "onboarding-styling"] as const;

export type ExportChunk = { index: number; rowCount: number; sha256: string; path: string; firstId: string; lastId: string };
export type ExportTable = { name: string; rowCount: number; sha256: string; chunks: ExportChunk[] };
export type ExportManifest = {
  format: typeof ORG_EXPORT_FORMAT; version: typeof ORG_EXPORT_VERSION; generatedAt: string;
  organization: { id: string; slug: string; name: string }; configuration: { path: string; sha256: string };
  tables: ExportTable[]; storage: null | { path: string; sha256: string; objectCount: number; truncated: boolean };
  excluded: Array<{ target: string; reason: string }>; manifestSha256: string | null;
};

/** What an archive never contains. Written into every manifest so a reader sees the boundary. */
export const ORG_EXPORT_EXCLUDED: ExportManifest["excluded"] = [
  { target: "auth.* / users / memberships / roles / permissions", reason: "global identities and access controls are not portable and hold no export value" },
  { target: "customer_onboarding_links / platform_access_invitations", reason: "token hashes are never exported" },
  { target: "platform_* / subscriptions / organization_features / organization_modules", reason: "operator-owned billing and entitlement data" },
  { target: "organizations.settings keys outside the reviewed list", reason: "only documents, followup_retention, dashboard, currency and evidence_retention_days are exported" },
  { target: "tables not in the reviewed allowlist (e.g. grooming_jobs, organization_bank_accounts, inventory, wallet, loyalty)", reason: "not yet reviewed for contents and cursor semantics" },
  { target: "Storage object bodies and signed URLs", reason: "this export records object metadata only" },
];

/** Key names that must never appear in an exported row, configuration or listing. */
export const FORBIDDEN_EXPORT_KEY = /(token|secret|password|passwd|api_?key|credential|signed_?url|service_?role|authorization)/i;

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function stableJson(value: unknown): string { return JSON.stringify(sort(value)); }
export function tableHash(chunks: ExportChunk[]): string { return sha256(chunks.map((chunk) => chunk.sha256).join("\n")); }
export function chunkPath(prefix: string, table: string, index: number): string { return `${prefix}/tables/${table}/chunk-${String(index).padStart(5, "0")}.jsonl`; }
export function sanitizeTabularCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
// Plain code-unit order, not localeCompare: the manifest hash must not depend on the server's locale.
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sort(item)]));
}
