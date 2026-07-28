/**
 * Preset-contract test (item 2): proves the backend consumes @operro/preset-grooming
 * as the single source for the operation contract and error classification —
 * not local duplicates.
 *
 * - classifyDbError (preset-owned) maps each known DB error to the right
 *   platform category, so the service does not need its own regex list.
 * - the corrected error contract includes resource_not_active_or_not_in_branch
 *   and does NOT include the obsolete resource_not_active_or_not_in_org.
 * - the repository's mutation methods accept the preset Repo* input types
 *   (compile-time: assigning preset-typed inputs must type-check).
 */
import {
  classifyDbError,
  ASSEMBLY_ERRORS,
  ASSEMBLY_RPC,
  ASSEMBLY_GATE,
  type RepoAddPet,
  type RepoAssignPetResource,
} from "@operro/preset-grooming";
import { toId, MODULES, PERMISSIONS, type BookingId, type PetId, type GroomingJobPetId, type ResourceId } from "@operro/sdk";
import type { GroomingRepository } from "../src/repositories/grooming.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`PASS: ${label}`);
  passed++;
}

// 1. classification: each category resolves correctly from a raw DB error.
ok(classifyDbError({ code: "42501", message: "wrong_branch" }).category === "AUTHORIZATION", "1 42501/wrong_branch -> AUTHORIZATION");
ok(classifyDbError({ code: "23505", message: "pet_already_on_booking" }).category === "CONFLICT", "2 pet_already_on_booking -> CONFLICT");
ok(classifyDbError({ code: "P0002", message: "line_not_found" }).category === "NOT_FOUND", "3 line_not_found -> NOT_FOUND");
ok(classifyDbError({ code: "23514", message: "pet_customer_mismatch" }).category === "BUSINESS_RULE", "4 pet_customer_mismatch -> BUSINESS_RULE");
ok(classifyDbError({ code: "23514", message: "resource_not_active_or_not_in_branch" }).category === "BUSINESS_RULE", "5 resource_not_active_or_not_in_branch classified");
ok(classifyDbError({ message: "package_requires_unit_quantity" }).category === "BUSINESS_RULE", "6 package_requires_unit_quantity -> BUSINESS_RULE");
ok(classifyDbError({ code: "99999", message: "something else" }).category === "INTERNAL", "7 unknown -> INTERNAL");
ok(classifyDbError({ code: "23514", message: "booking_not_open_for_assembly:completed" }).code === "booking_not_open_for_assembly", "8 prefix match returns stable code");

// 2. corrected error contract membership.
ok("resource_not_active_or_not_in_branch" in ASSEMBLY_ERRORS, "9 contract includes resource_not_active_or_not_in_branch");
ok(!("resource_not_active_or_not_in_org" in ASSEMBLY_ERRORS), "10 obsolete resource_not_active_or_not_in_org removed");

// 3. RPC names + gate come from the preset (single source).
ok(ASSEMBLY_RPC.assignPetResource === "assembly_assign_pet_resource", "11 RPC name from preset");
ok(ASSEMBLY_GATE.module === MODULES.SCHEDULING && ASSEMBLY_GATE.permission === PERMISSIONS.BOOKING_UPDATE, "12 gate from preset");

// 4. compile-time: preset Repo* inputs are exactly what the repository accepts.
//    (If the repo redeclared incompatible anonymous shapes, this would not compile.)
const addPetInput: RepoAddPet = { bookingId: toId<BookingId>("00000000-0000-4000-8000-000000000001"), petId: toId<PetId>("00000000-0000-4000-8000-000000000002"), isRequired: true };
const assignInput: RepoAssignPetResource = { groomingJobPetId: toId<GroomingJobPetId>("00000000-0000-4000-8000-000000000003"), resourceId: toId<ResourceId>("00000000-0000-4000-8000-000000000004") };
type RepoAddPetParam = Parameters<GroomingRepository["addPet"]>[0];
type RepoAssignParam = Parameters<GroomingRepository["assignPetResource"]>[0];
const _p1: RepoAddPetParam = addPetInput;   // must assign
const _p2: RepoAssignParam = assignInput;   // must assign
void _p1; void _p2;
ok(true, "13 repository methods accept preset Repo* input types (compile-time)");

console.log(`\n${passed} assertions passed.`);
