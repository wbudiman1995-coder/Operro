/**
 * Shared domain primitives. Persistence-agnostic (Rule 58): no rows, joins,
 * or triggers leak through these types.
 */
import type { UserId } from "../ids.js";

/** ISO 4217 currency code. Currency is always explicit (Rule 36). */
export type CurrencyCode = string;

/** ISO-8601 timestamp string. */
export type Timestamp = string;

/**
 * A monetary amount with its currency. `amount` is a decimal string to avoid
 * floating-point drift; the database stores numeric(14,2).
 */
export interface Money {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

/** Audit fields present on every business entity. */
export interface AuditInfo {
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly createdBy?: UserId;
  readonly updatedBy?: UserId;
}

/** Soft-delete marker. */
export interface SoftDeletable {
  readonly deletedAt?: Timestamp | null;
}
