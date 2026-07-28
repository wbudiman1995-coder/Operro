/**
 * Grooming repository — the only place domain ↔ rows translation happens for the
 * grooming vertical (Rule 61). Mutations call the approved RPCs (via the preset
 * contract's ASSEMBLY_RPC + toRpcArgs — item 6); reads map rows to SDK domain.
 * No direct table writes exist here (0013 revoked them).
 *
 * Item 5 fixes: loadJob loads the booking to derive the REAL organizationId and
 * branchId (never a fabricated ""), validates DB values at the boundary rather
 * than blindly casting, returns an EMPTY GroomingJob for a booking with zero
 * pets (null only when the booking itself is absent), and supports a live-only
 * default read plus an includeDeleted history read.
 */
import {
  isUuid,
  toId,
  type BookingId,
  type BranchId,
  type OrganizationId,
  type GroomingJobPetId,
  type LineId,
  type PetId,
  type ResourceId,
  type ServiceId,
  type GroomingJob,
  type GroomingJobPet,
  type GroomingJobPetService,
  type GroomingPetStatus,
} from "@operro/sdk";
import {
  ASSEMBLY_RPC,
  toRpcArgs,
  type RepoAddPet,
  type RepoRemovePet,
  type RepoAddLine,
  type RepoSetLineQuantity,
  type RepoVoidLine,
  type RepoAssignPetResource,
} from "@operro/preset-grooming";
import type { DatabaseClient } from "../infra/index.js";

interface BookingRow {
  id: string;
  organization_id: string;
  branch_id: string;
}
interface GroomingJobPetRow {
  id: string;
  organization_id: string;
  grooming_job_id: string;
  pet_id: string;
  sequence: number;
  status: string;
  is_required: boolean;
  assigned_resource_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
interface GroomingLineRow {
  id: string;
  organization_id: string;
  grooming_job_pet_id: string;
  service_id: string;
  service_name_snapshot: string;
  unit_price_snapshot: string;
  currency: string;
  quantity: number;
  duration_minutes: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const PET_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "complete",
  "skipped",
]);

export interface LoadJobOptions {
  /** Default false → live records only. True → include soft-deleted (history). */
  readonly includeDeleted?: boolean;
}

export interface GroomingRepository {
  loadJob(bookingId: BookingId, opts?: LoadJobOptions): Promise<GroomingJob | null>;
  addPet(input: RepoAddPet): Promise<GroomingJobPetId>;
  removePet(input: RepoRemovePet): Promise<void>;
  addLine(input: RepoAddLine): Promise<LineId>;
  setLineQuantity(input: RepoSetLineQuantity): Promise<void>;
  voidLine(input: RepoVoidLine): Promise<void>;
  assignPetResource(input: RepoAssignPetResource): Promise<void>;
}

/** Boundary validation: reject bad DB values loudly instead of casting blindly. */
function reqUuid(value: string, field: string): string {
  if (!isUuid(value)) throw new Error(`invalid_uuid_from_db:${field}`);
  return value;
}
function petStatus(value: string): GroomingPetStatus {
  if (!PET_STATUSES.has(value)) throw new Error(`invalid_pet_status_from_db:${value}`);
  return value as GroomingPetStatus;
}

export class SupabaseGroomingRepository implements GroomingRepository {
  constructor(private readonly db: DatabaseClient) {}

  async loadJob(bookingId: BookingId, opts?: LoadJobOptions): Promise<GroomingJob | null> {
    const includeDeleted = opts?.includeDeleted ?? false;

    // 1. Load the booking to derive the REAL org + branch (item 5).
    const bookings = await this.db.select<BookingRow>("bookings", { id: `eq.${bookingId}` });
    const booking = bookings[0];
    if (!booking) return null; // booking absent → NOT_FOUND upstream
    const organizationId = toId<OrganizationId>(reqUuid(booking.organization_id, "booking.organization_id"));
    const branchId = toId<BranchId>(reqUuid(booking.branch_id, "booking.branch_id"));

    // 2. Load pets (+ their lines). A booking with zero pets → empty job.
    const petRows = await this.db.select<GroomingJobPetRow>("grooming_job_pets", {
      grooming_job_id: `eq.${bookingId}`,
    });
    const pets = includeDeleted ? petRows : petRows.filter((p) => p.deleted_at === null);
    if (pets.length === 0) {
      return { bookingId, organizationId, branchId, pets: [] };
    }
    const lineRows = await this.db.select<GroomingLineRow>("grooming_job_pet_services", {
      grooming_job_pet_id: `in.(${pets.map((p) => p.id).join(",")})`,
    });
    const lines = includeDeleted ? lineRows : lineRows.filter((l) => l.deleted_at === null);
    const linesByPet = new Map<string, GroomingLineRow[]>();
    for (const l of lines) {
      const arr = linesByPet.get(l.grooming_job_pet_id) ?? [];
      arr.push(l);
      linesByPet.set(l.grooming_job_pet_id, arr);
    }
    return {
      bookingId,
      organizationId,
      branchId,
      pets: [...pets]
        .sort((a, b) => a.sequence - b.sequence)
        .map((p: GroomingJobPetRow) => this.toPet(p, linesByPet.get(p.id) ?? [])),
    };
  }

  private toPet(p: GroomingJobPetRow, lines: GroomingLineRow[]): GroomingJobPet {
    const base = {
      id: toId<GroomingJobPetId>(reqUuid(p.id, "gjp.id")),
      organizationId: toId<OrganizationId>(reqUuid(p.organization_id, "gjp.organization_id")),
      bookingId: toId<BookingId>(reqUuid(p.grooming_job_id, "gjp.grooming_job_id")),
      petId: toId<PetId>(reqUuid(p.pet_id, "gjp.pet_id")),
      sequence: p.sequence,
      status: petStatus(p.status),
      isRequired: p.is_required,
      services: lines.map((l: GroomingLineRow) => this.toLine(l)),
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      deletedAt: p.deleted_at,
    };
    return p.assigned_resource_id !== null
      ? { ...base, assignedGroomerId: toId<ResourceId>(reqUuid(p.assigned_resource_id, "gjp.assigned_resource_id")) }
      : base;
  }

  private toLine(l: GroomingLineRow): GroomingJobPetService {
    const base = {
      id: toId<LineId>(reqUuid(l.id, "line.id")),
      organizationId: toId<OrganizationId>(reqUuid(l.organization_id, "line.organization_id")),
      groomingJobPetId: toId<GroomingJobPetId>(reqUuid(l.grooming_job_pet_id, "line.grooming_job_pet_id")),
      serviceId: toId<ServiceId>(reqUuid(l.service_id, "line.service_id")),
      serviceName: l.service_name_snapshot,
      unitPrice: { amount: l.unit_price_snapshot, currency: l.currency },
      quantity: l.quantity,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
      deletedAt: l.deleted_at,
    };
    return l.duration_minutes !== null ? { ...base, durationMinutes: l.duration_minutes } : base;
  }

  async addPet(input: RepoAddPet): Promise<GroomingJobPetId> {
    const id = await this.db.rpc<string>(ASSEMBLY_RPC.addPet, toRpcArgs.addPet(input));
    return toId<GroomingJobPetId>(id);
  }
  async removePet(input: RepoRemovePet): Promise<void> {
    await this.db.rpc<void>(ASSEMBLY_RPC.removePet, toRpcArgs.removePet(input));
  }
  async addLine(input: RepoAddLine): Promise<LineId> {
    const id = await this.db.rpc<string>(ASSEMBLY_RPC.addLine, toRpcArgs.addLine(input));
    return toId<LineId>(id);
  }
  async setLineQuantity(input: RepoSetLineQuantity): Promise<void> {
    await this.db.rpc<void>(ASSEMBLY_RPC.setLineQuantity, toRpcArgs.setLineQuantity(input));
  }
  async voidLine(input: RepoVoidLine): Promise<void> {
    await this.db.rpc<void>(ASSEMBLY_RPC.voidLine, toRpcArgs.voidLine(input));
  }
  async assignPetResource(input: RepoAssignPetResource): Promise<void> {
    await this.db.rpc<void>(ASSEMBLY_RPC.assignPetResource, toRpcArgs.assignPetResource(input));
  }
}
