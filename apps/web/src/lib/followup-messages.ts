/**
 * Function index:
 * - KNOWN_FOLLOWUP_PLACEHOLDERS / KNOWN_RENEWAL_PLACEHOLDERS: the allow-lists the save RPC
 *   also enforces server-side (kept here too so the editor can validate before submit).
 * - findUnknownPlaceholders: client-side pre-check mirroring the server's own validation.
 * - buildFollowupMessage / buildRenewalMessage: pure, safe template interpolation.
 *
 * No HTML is ever produced here -- callers render the result as plain text (a <textarea> or
 * a React text node, both auto-escaping) and pass it through buildWhatsAppUrl's own
 * encodeURIComponent for the wa.me link. That is what makes names/templates safe as *text*
 * per the S35 brief; this module does not additionally HTML-escape anything.
 */

export const KNOWN_FOLLOWUP_PLACEHOLDERS = ["nama", "dogs", "days", "inactive_period", "biz"] as const;
export const KNOWN_RENEWAL_PLACEHOLDERS = ["nama", "dogs", "tier", "amount", "due_day", "biz"] as const;

export function findUnknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{([a-zA-Z_]+)\}/g)) {
    if (!allowed.includes(match[1])) found.add(match[1]);
  }
  return [...found];
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z_]+)\}/g, (full, key: string) => (key in values ? values[key] : full));
}

export interface FollowupMessageResult { text: string | null; blockedReason: string | null }

export function buildFollowupMessage(
  template: string,
  input: { customerName: string; pets: Array<{ name: string; daysSince: number }>; businessName: string },
): FollowupMessageResult {
  if (input.pets.length === 0) return { text: null, blockedReason: "tidak ada hewan overdue untuk pelanggan ini" };
  const maxDays = Math.max(...input.pets.map((p) => p.daysSince));
  const dogs = input.pets.map((p) => p.name).join(", ");
  const sameDay = input.pets.every((p) => p.daysSince === maxDays);
  const values: Record<string, string> = {
    nama: input.customerName, dogs, days: String(maxDays), inactive_period: `${maxDays} hari`, biz: input.businessName,
  };
  let text = interpolate(template, values);
  if (!sameDay) {
    const breakdown = input.pets.map((p) => `${p.name} (${p.daysSince} hari)`).join(", ");
    text += `\n\nRincian per hewan: ${breakdown}.`;
  }
  return { text, blockedReason: null };
}

export function buildRenewalMessage(
  template: string,
  input: {
    customerName: string; petLabel: string | null; tierName: string; businessName: string;
    amount: number | null; currency: string; amountBlockedReason: string | null; dueDay?: string | null;
  },
): FollowupMessageResult {
  if (input.amountBlockedReason) {
    return { text: null, blockedReason: input.amountBlockedReason };
  }
  if (input.amount === null) {
    return { text: null, blockedReason: "muat pratinjau perpanjangan terlebih dahulu untuk mengetahui estimasi biaya" };
  }
  const amountText = new Intl.NumberFormat("id-ID", { style: "currency", currency: input.currency || "IDR", maximumFractionDigits: 0 }).format(input.amount);
  const values: Record<string, string> = {
    nama: input.customerName, dogs: input.petLabel ?? "semua hewan", tier: input.tierName, amount: amountText,
    due_day: input.dueDay ?? "", biz: input.businessName,
  };
  return { text: interpolate(template, values), blockedReason: null };
}
