/** Pure diff helper for audit-events.ts, split out (no "server-only") so test/audit-diff.test.ts can import it directly. */
export type AuditAction = "INSERT" | "UPDATE" | "DELETE";

const FIELD_LABELS: Record<string, string> = {
  display_name: "Nama pelanggan",
  customer_code: "Kode pelanggan",
  email: "Email",
  phone: "Nomor telepon",
  source: "Sumber akuisisi",
  notes: "Catatan internal",
  address: "Alamat",
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

const AUDIT_METADATA_FIELDS = new Set(["created_at", "created_by", "updated_at", "updated_by"]);

export function auditFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.split("_").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

export function computeChangedFields(action: AuditAction, previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  if (action !== "UPDATE") return [];
  return Object.keys(next)
    .filter((key) => !AUDIT_METADATA_FIELDS.has(key) && JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .map(auditFieldLabel);
}
