/**
 * @operro/preset-grooming — BookingAssembly contract.
 *
 * The single source of truth for the grooming mutation operations: RPC names,
 * the module/permission gate, branded input types, argument mapping, and the
 * error-code map. Each operation maps 1:1 to a SECURITY DEFINER RPC in migration
 * 20260721001350 ("0100"). Clients NEVER write the grooming tables directly
 * (0013 revoked those privileges); they invoke these RPCs, which the DB
 * authorizes (tenant + scheduling module + booking.update + the booking branch)
 * and audits. The backend imports these constants/types rather than duplicating
 * them (item 6).
 */
import {
  MODULES,
  PERMISSIONS,
  type BookingId,
  type PetId,
  type ServiceId,
  type ResourceId,
  type GroomingJobPetId,
  type LineId,
  type BranchId,
} from "@operro/sdk";

/** The module + permission every assembly operation requires (branch-checked in DB). */
export const ASSEMBLY_GATE = {
  module: MODULES.SCHEDULING,
  permission: PERMISSIONS.BOOKING_UPDATE,
} as const;

/** RPC names — must match the DB function names exactly. */
export const ASSEMBLY_RPC = {
  addPet: "assembly_add_pet",
  removePet: "assembly_remove_pet",
  addLine: "assembly_add_line",
  setLineQuantity: "assembly_set_line_quantity",
  voidLine: "assembly_void_line",
  assignPetResource: "assembly_assign_pet_resource",
} as const;

// Inputs use branded SDK ids (not `string`), so a CustomerId or a raw string
// cannot be passed where a PetId is expected (item 6).
export interface AddPetInput {
  readonly bookingId: BookingId;
  readonly petId: PetId;
  readonly branchId?: BranchId;
  readonly isRequired?: boolean; // default true
}
export interface RemovePetInput {
  readonly groomingJobPetId: GroomingJobPetId;
  readonly reason: string; // required, non-empty
  readonly branchId?: BranchId;
}
export interface AddLineInput {
  readonly groomingJobPetId: GroomingJobPetId;
  readonly serviceId: ServiceId;
  readonly quantity?: number; // default 1, must be >= 1
  readonly branchId?: BranchId;
}
export interface SetLineQuantityInput {
  readonly lineId: LineId;
  readonly quantity: number; // >= 1; rejected if the line has a package reservation
  readonly branchId?: BranchId;
}
export interface VoidLineInput {
  readonly lineId: LineId;
  readonly reason: string; // required, non-empty
  readonly branchId?: BranchId;
}
export interface AssignPetResourceInput {
  readonly groomingJobPetId: GroomingJobPetId;
  readonly resourceId: ResourceId;
  readonly branchId?: BranchId;
}

/** Maps an operation input to the positional RPC args the DB function expects. */
export const toRpcArgs = {
  addPet: (i: AddPetInput) => ({
    p_booking: i.bookingId,
    p_pet: i.petId,
    p_is_required: i.isRequired ?? true,
  }),
  removePet: (i: RemovePetInput) => ({ p_pet: i.groomingJobPetId, p_reason: i.reason }),
  addLine: (i: AddLineInput) => ({
    p_pet: i.groomingJobPetId,
    p_service: i.serviceId,
    p_quantity: i.quantity ?? 1,
  }),
  setLineQuantity: (i: SetLineQuantityInput) => ({ p_line: i.lineId, p_quantity: i.quantity }),
  voidLine: (i: VoidLineInput) => ({ p_line: i.lineId, p_reason: i.reason }),
  assignPetResource: (i: AssignPetResourceInput) => ({
    p_pet: i.groomingJobPetId,
    p_resource: i.resourceId,
  }),
} as const;

/**
 * The platform error categories a caller maps DB failures onto. The preset OWNS
 * this classification so the backend service does not maintain its own regex
 * list of business-error names (item 2).
 */
export type PlatformErrorCategory =
  | "AUTHORIZATION"
  | "CONFLICT"
  | "NOT_FOUND"
  | "BUSINESS_RULE"
  | "INTERNAL";

/**
 * Stable business/authorization error strings the assembly + reservation RPCs
 * raise, each mapped to a SQLSTATE and a platform category. This is the single
 * source of truth; keep in lockstep with the migration's RAISE statements.
 *
 * Note: the resource check raises `resource_not_active_or_not_in_branch`
 * (branch-scoped, per correction). There is NO `resource_not_active_or_not_in_org`
 * — no RPC raises it — so it is intentionally absent (item 2).
 */
export const ASSEMBLY_ERRORS = {
  // not found (SQLSTATE P0002 / no_data_found)
  booking_not_found: { sqlstate: "P0002", category: "NOT_FOUND" },
  pet_not_found: { sqlstate: "P0002", category: "NOT_FOUND" },
  line_not_found: { sqlstate: "P0002", category: "NOT_FOUND" },
  package_not_found: { sqlstate: "P0002", category: "NOT_FOUND" },
  customer_package_not_found: { sqlstate: "P0002", category: "NOT_FOUND" },
  // conflict (23505 / unique_violation)
  pet_already_on_booking: { sqlstate: "23505", category: "CONFLICT" },
  // business rule (23514 / check_violation)
  booking_not_open_for_assembly: { sqlstate: "23514", category: "BUSINESS_RULE" },
  pet_not_in_org: { sqlstate: "23514", category: "BUSINESS_RULE" },
  pet_customer_mismatch: { sqlstate: "23514", category: "BUSINESS_RULE" },
  pet_removal_is_permanent: { sqlstate: "23514", category: "BUSINESS_RULE" },
  service_not_active_or_not_in_org: { sqlstate: "23514", category: "BUSINESS_RULE" },
  resource_not_active_or_not_in_branch: { sqlstate: "23514", category: "BUSINESS_RULE" },
  quantity_must_be_positive: { sqlstate: "23514", category: "BUSINESS_RULE" },
  line_has_realized_effects_use_void: { sqlstate: "23514", category: "BUSINESS_RULE" },
  line_has_package_reservation: { sqlstate: "23514", category: "BUSINESS_RULE" },
  package_requires_unit_quantity: { sqlstate: "23514", category: "BUSINESS_RULE" },
  package_not_active: { sqlstate: "23514", category: "BUSINESS_RULE" },
  package_expired: { sqlstate: "23514", category: "BUSINESS_RULE" },
  package_not_applicable_to_service: { sqlstate: "23514", category: "BUSINESS_RULE" },
  package_customer_mismatch: { sqlstate: "23514", category: "BUSINESS_RULE" },
  no_sessions_available: { sqlstate: "23514", category: "BUSINESS_RULE" },
  reason_required: { sqlstate: "23514", category: "BUSINESS_RULE" },
} as const satisfies Record<string, { sqlstate: string; category: PlatformErrorCategory }>;

export type AssemblyErrorCode = keyof typeof ASSEMBLY_ERRORS;

/** Shape of a raw DB/driver error (subset we rely on). */
export interface RawDbError {
  readonly code?: string;
  readonly message?: string;
}

/**
 * Preset-owned classification (item 2): turn a raw DB error into a platform
 * category using the known error contract first, then SQLSTATE, without the
 * caller keeping its own list of business-error names. Also returns the matched
 * stable code (if any) so callers can surface it.
 */
export function classifyDbError(e: unknown): { category: PlatformErrorCategory; code?: AssemblyErrorCode } {
  const err = (e ?? {}) as RawDbError;
  const msg = err.message ?? "";
  // 1. Match a known stable error name embedded in the message (RPCs raise
  //    'name' or 'name:detail', so match by prefix token).
  for (const key of Object.keys(ASSEMBLY_ERRORS) as AssemblyErrorCode[]) {
    if (msg.includes(key)) {
      return { category: ASSEMBLY_ERRORS[key].category, code: key };
    }
  }
  // 2. Authorization comes from assert_tenant_authorized (SQLSTATE 42501) or its
  //    reason strings, which are SDK/DB authz reasons, not assembly errors.
  if (err.code === "42501" || /wrong_branch|missing_permission|missing_module|no_active_membership|wrong_organization/.test(msg)) {
    return { category: "AUTHORIZATION" };
  }
  // 3. Fall back to SQLSTATE class.
  switch (err.code) {
    case "23505": return { category: "CONFLICT" };
    case "P0002": return { category: "NOT_FOUND" };
    case "23514": return { category: "BUSINESS_RULE" };
    default: return { category: "INTERNAL" };
  }
}

// ---- Repository-facing input shapes (persistence inputs, no ctx/branch) ------
// The repository imports THESE from the preset instead of redeclaring anonymous
// object shapes (item 2). They are the sanctioned inputs to each RPC call.
export interface RepoAddPet { bookingId: BookingId; petId: PetId; isRequired: boolean }
export interface RepoRemovePet { groomingJobPetId: GroomingJobPetId; reason: string }
export interface RepoAddLine { groomingJobPetId: GroomingJobPetId; serviceId: ServiceId; quantity: number }
export interface RepoSetLineQuantity { lineId: LineId; quantity: number }
export interface RepoVoidLine { lineId: LineId; reason: string }
export interface RepoAssignPetResource { groomingJobPetId: GroomingJobPetId; resourceId: ResourceId }
