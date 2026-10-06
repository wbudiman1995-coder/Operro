export const CUSTOMER_PROFILE_MAX_NAME = 120;
export const CUSTOMER_PROFILE_MAX_PHONE = 40;
export const CUSTOMER_PROFILE_MAX_EMAIL = 254;
export const CUSTOMER_PROFILE_MAX_SOURCE = 80;
export const CUSTOMER_PROFILE_MAX_NOTES = 4000;

export const CUSTOMER_PROFILE_UPDATE_KEYS = ["display_name", "phone", "email", "source", "notes"] as const;
export type CustomerProfileUpdateKey = (typeof CUSTOMER_PROFILE_UPDATE_KEYS)[number];

export interface CustomerProfileUpdate {
  display_name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  notes: string | null;
}

export interface CustomerProfileFailure {
  field: CustomerProfileUpdateKey;
  message: string;
}

export type CustomerProfileParseResult =
  | { ok: true; update: CustomerProfileUpdate }
  | { ok: false; failures: CustomerProfileFailure[] };

export type CustomerProfileFieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function readSingleFormValue(formData: FormData, key: string): CustomerProfileFieldResult<string> {
  const values = formData.getAll(key);
  if (values.length === 0) return { ok: true, value: "" };
  if (values.length > 1) return { ok: false, message: "Kolom dikirim lebih dari sekali." };
  const only = values[0];
  return typeof only === "string" ? { ok: true, value: only } : { ok: false, message: "Kolom harus berupa teks." };
}

export function normalizeCustomerName(raw: string): CustomerProfileFieldResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, message: "Nama pelanggan wajib diisi." };
  if (countCharacters(trimmed) > CUSTOMER_PROFILE_MAX_NAME) return { ok: false, message: `Nama pelanggan maksimal ${CUSTOMER_PROFILE_MAX_NAME} karakter.` };
  return { ok: true, value: trimmed };
}

export function normalizeCustomerPhone(raw: string): CustomerProfileFieldResult<string | null> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (countCharacters(trimmed) > CUSTOMER_PROFILE_MAX_PHONE) return { ok: false, message: `Telepon maksimal ${CUSTOMER_PROFILE_MAX_PHONE} karakter.` };
  return { ok: true, value: trimmed };
}

export function normalizeCustomerEmail(raw: string): CustomerProfileFieldResult<string | null> {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (countCharacters(trimmed) > CUSTOMER_PROFILE_MAX_EMAIL) return { ok: false, message: `Email maksimal ${CUSTOMER_PROFILE_MAX_EMAIL} karakter.` };
  if (!EMAIL_PATTERN.test(trimmed)) return { ok: false, message: "Email tidak valid." };
  return { ok: true, value: trimmed };
}

export function normalizeCustomerSource(raw: string): CustomerProfileFieldResult<string | null> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (countCharacters(trimmed) > CUSTOMER_PROFILE_MAX_SOURCE) return { ok: false, message: `Sumber maksimal ${CUSTOMER_PROFILE_MAX_SOURCE} karakter.` };
  return { ok: true, value: trimmed };
}

export function normalizeCustomerNotes(raw: string): CustomerProfileFieldResult<string | null> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (countCharacters(trimmed) > CUSTOMER_PROFILE_MAX_NOTES) return { ok: false, message: `Catatan maksimal ${CUSTOMER_PROFILE_MAX_NOTES} karakter.` };
  return { ok: true, value: trimmed };
}

export function isCustomerId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseExpectedUpdatedAt(raw: string): CustomerProfileFieldResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64 || Number.isNaN(new Date(trimmed).getTime())) {
    return { ok: false, message: "Versi data pelanggan tidak valid." };
  }
  return { ok: true, value: trimmed };
}

export function parseCustomerProfileForm(formData: FormData): CustomerProfileParseResult {
  const failures: CustomerProfileFailure[] = [];
  const update: Partial<CustomerProfileUpdate> = {};
  const fields = [
    ["display_name", normalizeCustomerName],
    ["phone", normalizeCustomerPhone],
    ["email", normalizeCustomerEmail],
    ["source", normalizeCustomerSource],
    ["notes", normalizeCustomerNotes],
  ] as const;

  for (const [field, normalize] of fields) {
    const raw = readSingleFormValue(formData, field);
    if (!raw.ok) {
      failures.push({ field, message: raw.message });
      continue;
    }
    const normalized = normalize(raw.value);
    if (!normalized.ok) failures.push({ field, message: normalized.message });
    else update[field] = normalized.value as never;
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, update: update as CustomerProfileUpdate };
}
