/**
 * Function index:
 * - LANDING_PAGES / landingHref: the closed set of personal landing choices and their fixed routes.
 * - parseLandingChoice: validates a submitted choice ("" clears it).
 * - parseEvidenceRetentionDays: validates the organization-owned retention setting.
 *
 * Two stores, kept apart on purpose:
 * - organization-owned: organizations.settings.evidence_retention_days (owner-only, shared by the business);
 * - user-owned: public.user_preferences.landing_page (one person, any business).
 * The route is chosen from a closed map, never from submitted text, and the database re-validates the saved
 * choice against the caller's live capabilities (app.my_landing_page), so revoked access falls back to /dashboard.
 */
export const LANDING_PAGES = [
  { key: "dashboard", label: "Ringkasan", href: "/dashboard", capability: null },
  { key: "schedule", label: "Kalender", href: "/schedule", capability: "booking.read" },
  { key: "customers", label: "Pelanggan", href: "/customers", capability: "customer.read" },
  { key: "finance", label: "Keuangan", href: "/finance", capability: "finance.read" },
] as const;
export type LandingKey = (typeof LANDING_PAGES)[number]["key"];

export const EVIDENCE_RETENTION_MIN = 30;
export const EVIDENCE_RETENTION_MAX = 1825;
export const EVIDENCE_RETENTION_DEFAULT = 365;

const BY_KEY = new Map<string, (typeof LANDING_PAGES)[number]>(LANDING_PAGES.map((page) => [page.key, page]));

export function landingHref(value: unknown): string {
  return (typeof value === "string" ? BY_KEY.get(value)?.href : undefined) ?? "/dashboard";
}

/** null clears the preference; undefined means the submission was malformed. */
export function parseLandingChoice(value: unknown): LandingKey | null | undefined {
  if (value === "") return null;
  return typeof value === "string" && BY_KEY.has(value) ? (value as LandingKey) : undefined;
}

export function parseEvidenceRetentionDays(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[0-9]{1,4}$/.test(value.trim())) return undefined;
  const days = Number(value.trim());
  return days >= EVIDENCE_RETENTION_MIN && days <= EVIDENCE_RETENTION_MAX ? days : undefined;
}

/** Reads the stored setting defensively; anything malformed shows the platform default the trigger would use. */
export function readEvidenceRetentionDays(settings: unknown): number {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return EVIDENCE_RETENTION_DEFAULT;
  const raw = (settings as Record<string, unknown>).evidence_retention_days;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= EVIDENCE_RETENTION_MIN && raw <= EVIDENCE_RETENTION_MAX
    ? raw
    : EVIDENCE_RETENTION_DEFAULT;
}
