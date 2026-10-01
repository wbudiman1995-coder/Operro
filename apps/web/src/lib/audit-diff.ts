/** Pure diff helper for audit-events.ts, split out (no "server-only") so test/audit-diff.test.ts can import it directly. */
export type AuditAction = "INSERT" | "UPDATE" | "DELETE";

export function computeChangedFields(action: AuditAction, previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  if (action !== "UPDATE") return [];
  return Object.keys(next).filter((key) => key !== "updated_at" && JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}
