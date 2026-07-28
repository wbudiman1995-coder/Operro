/**
 * Branded identifier types.
 *
 * Every entity id is a distinct nominal type, so a `CustomerId` can never be
 * passed where a `BookingId` is expected — mistakes the database would only
 * catch at runtime are caught at compile time instead (Rule 55: one canonical
 * representation per concept).
 */

declare const __brand: unique symbol;

/** A nominal brand over a base type. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Underlying storage type for all ids (UUID v7 text). */
export type Uuid = string;

export type OrganizationId = Brand<Uuid, "OrganizationId">;
export type BranchId = Brand<Uuid, "BranchId">;
export type UserId = Brand<Uuid, "UserId">;
export type MembershipId = Brand<Uuid, "MembershipId">;
export type RoleId = Brand<Uuid, "RoleId">;
export type CustomerId = Brand<Uuid, "CustomerId">;
export type PetId = Brand<Uuid, "PetId">;
export type ResourceId = Brand<Uuid, "ResourceId">;
export type BookingId = Brand<Uuid, "BookingId">;
export type ServiceId = Brand<Uuid, "ServiceId">;
// Grooming vertical (0013 tables + Batch 2 assembly).
export type GroomingJobPetId = Brand<Uuid, "GroomingJobPetId">;
/** grooming_job_pet_services.id — one service line for one pet on one booking. */
export type LineId = Brand<Uuid, "LineId">;
export type PackageReservationId = Brand<Uuid, "PackageReservationId">;
export type CustomerPackageId = Brand<Uuid, "CustomerPackageId">;
export type ProductId = Brand<Uuid, "ProductId">;
export type OrderId = Brand<Uuid, "OrderId">;
export type InvoiceId = Brand<Uuid, "InvoiceId">;
export type PaymentId = Brand<Uuid, "PaymentId">;
export type PayrollRunId = Brand<Uuid, "PayrollRunId">;
export type ExpenseId = Brand<Uuid, "ExpenseId">;
export type AttachmentId = Brand<Uuid, "AttachmentId">;

/** Any branded id. */
export type EntityId = Brand<Uuid, string>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a syntactically valid UUID string. */
export function isUuid(value: unknown): value is Uuid {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Cast a validated string to a branded id. This is the single sanctioned
 * place where the brand is applied; call it at trust boundaries (after a
 * validation schema has confirmed the shape) rather than sprinkling `as`.
 */
export function toId<B extends EntityId>(value: Uuid): B {
  return value as B;
}
