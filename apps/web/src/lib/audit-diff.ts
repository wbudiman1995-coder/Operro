/** Pure diff helper for audit-events.ts, split out (no "server-only") so test/audit-diff.test.ts can import it directly. */
export type AuditAction = "INSERT" | "UPDATE" | "DELETE";

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  customer_notes: "Catatan pelanggan",
  internal_groomer_notes: "Catatan internal groomer",
  due_at: "Jatuh tempo",
  issued_at: "Tanggal terbit",
  paid_at: "Tanggal dibayar",
  subtotal: "Subtotal",
  discount_total: "Diskon",
  tax_total: "Pajak",
  total: "Total",
  currency: "Mata uang",
  invoice_number: "Nomor invoice",
};

export function auditFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.split("_").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

export function computeChangedFields(action: AuditAction, previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  if (action !== "UPDATE") return [];
  return Object.keys(next)
    .filter((key) => key !== "updated_at" && JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .map(auditFieldLabel);
}
