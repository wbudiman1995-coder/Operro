/**
 * Function index:
 * - WHATSAPP_STATUS_LABELS / SOURCE_LABELS: honest user-facing wording for the user-reported lifecycle.
 * - allowedNextStatuses: the transitions the database also enforces (kept in sync; the RPC is authoritative).
 * - blockedReason: why a draft cannot be opened/marked sent right now (opt-out, archived source, no phone, onboarding).
 * - renderStrict: template interpolation that REFUSES unresolved {placeholders} instead of sending them to a customer.
 * - invoiceDraftMessage / onboardingDraftMessage: pure message builders over already-loaded data.
 * - waUrl: the wa.me link for a stored recipient + message.
 *
 * Nothing here sends a message. "opened" means a person clicked the wa.me link; "marked_sent" is what a person
 * reports. Neither is provider-confirmed delivery and the UI must not say so.
 */
export const WHATSAPP_STATUSES = ["draft", "opened", "marked_sent", "failed", "canceled"] as const;
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number];
export const WHATSAPP_SOURCES = ["invoice", "followup", "renewal", "onboarding"] as const;
export type WhatsAppSource = (typeof WHATSAPP_SOURCES)[number];

export const WHATSAPP_STATUS_LABELS: Record<WhatsAppStatus, string> = {
  draft: "Draf (belum dibuka)",
  opened: "Dibuka di WhatsApp (belum tentu terkirim)",
  marked_sent: "Ditandai terkirim oleh pengguna",
  failed: "Ditandai gagal oleh pengguna",
  canceled: "Dibatalkan",
};
export const SOURCE_LABELS: Record<WhatsAppSource, string> = {
  invoice: "Invoice",
  followup: "Follow-up",
  renewal: "Perpanjangan",
  onboarding: "Undangan pendaftaran",
};

const NEXT: Record<WhatsAppStatus, WhatsAppStatus[]> = {
  draft: ["opened", "marked_sent", "failed", "canceled"],
  opened: ["marked_sent", "failed", "canceled"],
  failed: ["draft", "canceled"],
  marked_sent: [],
  canceled: [],
};
export function allowedNextStatuses(status: WhatsAppStatus): WhatsAppStatus[] {
  return NEXT[status];
}

export interface DraftHealth {
  optedOut: boolean;
  customerArchived: boolean;
  /** The customer's phone today no longer matches the number frozen on the draft. */
  phoneChanged: boolean;
}

/** Reason the draft cannot currently be opened or marked sent, or null. Cancel/fail stay available regardless. */
export function blockedReason(source: WhatsAppSource, recipientPhone: string | null, health: DraftHealth): string | null {
  if (health.optedOut) return "Pelanggan berhenti menerima pesan WhatsApp.";
  if (health.customerArchived) return "Pelanggan sudah diarsipkan.";
  if (source !== "onboarding" && !recipientPhone) return "Nomor WhatsApp tidak tersedia.";
  return null;
}

const PLACEHOLDER = /\{([a-zA-Z_]+)\}/g;

/** Interpolates {name}; any placeholder without a value makes the whole render fail (null). */
export function renderStrict(template: string, values: Record<string, string>): string | null {
  let missing = false;
  const text = template.replace(PLACEHOLDER, (_full, key: string) => {
    if (key in values) return values[key];
    missing = true;
    return "";
  });
  return missing ? null : text;
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("id-ID", { style: "currency", currency: currency || "IDR", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export interface InvoiceDraftInput {
  template: string;
  customerName: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  notes: string;
}
export function invoiceDraftMessage(input: InvoiceDraftInput): { text: string | null; blockedReason: string | null } {
  // The stored org templates use {customer} {number} {total} {notes}; unknown placeholders are refused, not blanked.
  const text = renderStrict(input.template, {
    customer: input.customerName,
    number: input.invoiceNumber,
    total: formatMoney(input.amount, input.currency),
    notes: input.notes,
  });
  return text === null ? { text: null, blockedReason: "Template WhatsApp invoice memakai variabel yang tidak dikenal." } : { text, blockedReason: null };
}

/** The one-time link must never be persisted, so the stored text carries a marker in its place. */
export const ONBOARDING_LINK_MARKER = "[link pendaftaran sekali pakai — salin dari halaman Onboarding saat dibuat]";
export function onboardingDraftMessage(template: string, businessName: string): string | null {
  return renderStrict(template, { business: businessName, link: ONBOARDING_LINK_MARKER });
}

export function waUrl(recipientPhone: string | null, message: string): string | null {
  if (!recipientPhone || !/^[1-9][0-9]{7,14}$/.test(recipientPhone)) return null;
  return `https://wa.me/${recipientPhone}?text=${encodeURIComponent(message)}`;
}

export function maskPhone(phone: string | null): string {
  if (!phone) return "—";
  return phone.length <= 6 ? phone : `${phone.slice(0, 4)}…${phone.slice(-3)}`;
}

export function isWhatsAppStatus(value: unknown): value is WhatsAppStatus {
  return typeof value === "string" && (WHATSAPP_STATUSES as readonly string[]).includes(value);
}
export function isWhatsAppSource(value: unknown): value is WhatsAppSource {
  return typeof value === "string" && (WHATSAPP_SOURCES as readonly string[]).includes(value);
}
