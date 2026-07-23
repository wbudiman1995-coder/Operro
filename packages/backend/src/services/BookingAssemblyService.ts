/**
 * BookingAssemblyService — business entry point for grooming mutations
 * (Rule 62/63/65). One method per capability, `Result` out, never a raw row.
 *
 * The operation CONTRACT (input types, gate, RPC names, arg mapping, error map)
 * is @operro/preset-grooming (blocker 4). This service imports the preset input
 * types directly and does NOT redeclare them, nor duplicate the gate object or
 * business-error strings. It authorizes via the PlatformContext pre-filter
 * (Rule 59) using ASSEMBLY_GATE, then delegates to the repository, which calls
 * the RPCs. The database RLS + RPC authorization remain the final authority
 * (Rule 56); reason strings match on both sides (Rules 47/53).
 *
 * No TimelinePort: the database RPCs already write the audit timeline event
 * (assembly_audit); duplicating it in the app would double-log.
 */
import {
  authorize,
  ok,
  err,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  ResourceNotFound,
  InternalError,
  MODULES,
  PERMISSIONS,
  type PlatformContext,
  type Result,
  type PlatformError,
  type BookingId,
  type BranchId,
  type GroomingJobPetId,
  type LineId,
  type GroomingJob,
} from "@operro/sdk";
import {
  ASSEMBLY_GATE,
  classifyDbError,
  type PlatformErrorCategory,
  type AddPetInput,
  type RemovePetInput,
  type AddLineInput,
  type SetLineQuantityInput,
  type VoidLineInput,
  type AssignPetResourceInput,
} from "@operro/preset-grooming";
import type { GroomingRepository } from "../repositories/grooming.js";

export interface AssemblyDeps {
  readonly grooming: GroomingRepository;
}

/**
 * Map a DB/repo error to the platform error vocabulary using the preset-owned
 * classifier (item 2) — the service keeps NO independent regex list of business
 * error names. The preset returns a category + the matched stable code; we wrap
 * that in the SDK error type, preserving the DB message.
 */
function mapDbError(e: unknown): PlatformError {
  const msg = (e as { message?: string })?.message ?? "";
  const { category }: { category: PlatformErrorCategory } = classifyDbError(e);
  switch (category) {
    case "AUTHORIZATION": return new AuthorizationError(msg || "not_authorized");
    case "CONFLICT": return new ConflictError(msg || "conflict");
    case "NOT_FOUND": return new ResourceNotFound("grooming_record");
    case "BUSINESS_RULE": return new BusinessRuleError(msg || "business_rule");
    default: return new InternalError(msg || "assembly_failed");
  }
}

export class BookingAssemblyService {
  constructor(private readonly deps: AssemblyDeps) {}

  private get repo(): GroomingRepository {
    return this.deps.grooming;
  }

  private gate(ctx: PlatformContext, branchId?: BranchId): Result<true, AuthorizationError> {
    return authorize(ctx, {
      module: ASSEMBLY_GATE.module,
      permission: ASSEMBLY_GATE.permission,
      ...(branchId ? { branch: branchId } : {}),
    });
  }

  async getJob(
    ctx: PlatformContext,
    input: { bookingId: BookingId; branchId?: BranchId; includeDeleted?: boolean },
  ): Promise<Result<GroomingJob, PlatformError>> {
    const g = authorize(ctx, {
      module: MODULES.SCHEDULING,
      permission: PERMISSIONS.BOOKING_READ,
      ...(input.branchId ? { branch: input.branchId } : {}),
    });
    if (!g.ok) return err(g.error);
    try {
      const job = await this.repo.loadJob(input.bookingId, { includeDeleted: input.includeDeleted ?? false });
      if (job === null) return err(new ResourceNotFound("booking", input.bookingId));
      return ok(job);
    } catch (e) {
      return err(mapDbError(e));
    }
  }

  async addPet(
    ctx: PlatformContext,
    input: AddPetInput,
  ): Promise<Result<{ groomingJobPetId: GroomingJobPetId }, PlatformError>> {
    const g = this.gate(ctx, input.branchId);
    if (!g.ok) return err(g.error);
    try {
      const id = await this.repo.addPet({
        bookingId: input.bookingId,
        petId: input.petId,
        isRequired: input.isRequired ?? true,
      });
      return ok({ groomingJobPetId: id });
    } catch (e) {
      return err(mapDbError(e));
    }
  }

  async removePet(ctx: PlatformContext, input: RemovePetInput): Promise<Result<true, PlatformError>> {
    if (!input.reason?.trim()) return err(new BusinessRuleError("reason_required"));
    const g = this.gate(ctx, input.branchId);
    if (!g.ok) return err(g.error);
    try {
      await this.repo.removePet({ groomingJobPetId: input.groomingJobPetId, reason: input.reason });
      return ok(true);
    } catch (e) {
      return err(mapDbError(e));
    }
  }

  async addLine(
    ctx: PlatformContext,
    input: AddLineInput,
  ): Promise<Result<{ lineId: LineId }, PlatformError>> {
    const qty = input.quantity ?? 1;
    if (qty < 1) return err(new BusinessRuleError("quantity_must_be_positive"));
    const g = this.gate(ctx, input.branchId);
    if (!g.ok) return err(g.error);
    try {
      const id = await this.repo.addLine({
        groomingJobPetId: input.groomingJobPetId,
        serviceId: input.serviceId,
        quantity: qty,
      });
      return ok({ lineId: id });
    } catch (e) {
      return err(mapDbError(e));
    }
  }

  async setLineQuantity(ctx: PlatformContext, input: SetLineQuantityInput): Promise<Result<true, PlatformError>> {
    if (input.quantity < 1) return err(new BusinessRuleError("quantity_must_be_positive"));
    const g = this.gate(ctx, input.branchId);
    if (!g.ok) return err(g.error);
    try {
      await this.repo.setLineQuantity({ lineId: input.lineId, quantity: input.quantity });
      return ok(true);
    } catch (e) {
      return err(mapDbError(e));
    }
  }

  async voidLine(ctx: PlatformContext, input: VoidLineInput): Promise<Result<true, PlatformError>> {
    if (!input.reason?.trim()) return err(new BusinessRuleError("reason_required"));
    const g = this.gate(ctx, input.branchId);
    if (!g.ok) return err(g.error);
    try {
      await this.repo.voidLine({ lineId: input.lineId, reason: input.reason });
      return ok(true);
    } catch (e) {
      return err(mapDbError(e));
    }
  }

  async assignPetResource(ctx: PlatformContext, input: AssignPetResourceInput): Promise<Result<true, PlatformError>> {
    const g = this.gate(ctx, input.branchId);
    if (!g.ok) return err(g.error);
    try {
      await this.repo.assignPetResource({
        groomingJobPetId: input.groomingJobPetId,
        resourceId: input.resourceId,
      });
      return ok(true);
    } catch (e) {
      return err(mapDbError(e));
    }
  }
}
