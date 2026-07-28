/**
 * Grooming domain models (Batch 2).
 *
 * The public, persistence-agnostic shape of an assembled grooming booking. This
 * is the canonical answer to "a booking has many pets, each pet has many service
 * lines, each pet has its own assigned groomer" — the model 0013 restructured
 * the database to support and that replaces the legacy one-dog/one-service
 * appointment. No row/column/trigger detail leaks through these types (Rule 58);
 * the repository maps rows ↔ these models.
 *
 * IMPORTANT: a booking does NOT carry a pet_id or service_id. Those columns were
 * dropped in 0013. Pets and services hang off the grooming job composition
 * below. Any code that reaches for `booking.petId` / `booking.serviceId` is
 * working against the old model and is a defect.
 */
import type {
  BookingId,
  BranchId,
  GroomingJobPetId,
  LineId,
  OrganizationId,
  PetId,
  ResourceId,
  ServiceId,
} from "../ids.js";
import type { AuditInfo, Money, SoftDeletable } from "./common.js";

/** Execution status of one pet's grooming within a booking. */
export type GroomingPetStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "skipped";

/** One service performed for one pet on one booking (the authoritative line). */
export interface GroomingJobPetService extends AuditInfo, SoftDeletable {
  readonly id: LineId;
  readonly organizationId: OrganizationId;
  readonly groomingJobPetId: GroomingJobPetId;
  readonly serviceId: ServiceId;
  /** Snapshot at line creation; the commercial source of truth for effects. */
  readonly serviceName: string;
  readonly unitPrice: Money;
  /**
   * Read-only in the application tier. Changed ONLY via
   * `app.assembly_set_line_quantity` (0013 revoked the direct client UPDATE).
   */
  readonly quantity: number;
  readonly durationMinutes?: number;
}

/** One pet within a booking's grooming job, with its own groomer + lines. */
export interface GroomingJobPet extends AuditInfo, SoftDeletable {
  readonly id: GroomingJobPetId;
  readonly organizationId: OrganizationId;
  readonly bookingId: BookingId; // = grooming_job_id
  readonly petId: PetId;
  readonly sequence: number;
  readonly status: GroomingPetStatus;
  readonly isRequired: boolean;
  /** Per-pet assigned groomer (authoritative; set via controlled ops). */
  readonly assignedGroomerId?: ResourceId;
  readonly services: ReadonlyArray<GroomingJobPetService>;
}

/** The assembled grooming booking: many pets, each with many service lines. */
export interface GroomingJob {
  readonly bookingId: BookingId;
  readonly organizationId: OrganizationId;
  readonly branchId: BranchId;
  readonly pets: ReadonlyArray<GroomingJobPet>;
}

/** Convenience: total price across all live lines (display only; DB is truth). */
export function groomingJobSubtotal(job: GroomingJob): Money | null {
  const live = job.pets
    .filter((p) => !p.deletedAt)
    .flatMap((p) => p.services.filter((s) => !s.deletedAt));
  if (live.length === 0) return null;
  const currency = live[0]!.unitPrice.currency;
  let cents = 0;
  for (const s of live) {
    if (s.unitPrice.currency !== currency) return null; // mixed currency: caller decides
    cents += Math.round(parseFloat(s.unitPrice.amount) * 100) * s.quantity;
  }
  return { amount: (cents / 100).toFixed(2), currency };
}
