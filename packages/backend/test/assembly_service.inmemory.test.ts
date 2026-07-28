/**
 * In-memory service test (Rule 66): the REAL BookingAssemblyService runs
 * unchanged against an in-memory GroomingRepository fake. No DB. Proves the
 * app-tier authorize() pre-filter, Result outcomes, error mapping, the new
 * assignPetResource op, and the empty-job read semantics (item 5).
 */
import {
  MODULES,
  PERMISSIONS,
  toId,
  type PlatformContext,
  type BookingId,
  type BranchId,
  type PetId,
  type ServiceId,
  type ResourceId,
  type GroomingJobPetId,
  type LineId,
  type OrganizationId,
  type UserId,
  type MembershipId,
  type PermissionKey,
  type ModuleKey,
  type GroomingJob,
} from "@operro/sdk";
import type { GroomingRepository, LoadJobOptions } from "../src/repositories/grooming.js";
import { BookingAssemblyService } from "../src/services/BookingAssemblyService.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`PASS: ${label}`);
  passed++;
}

class InMemoryGroomingRepo implements GroomingRepository {
  public calls: string[] = [];
  private seq = 0;
  public emptyJob = false;
  async loadJob(bookingId: BookingId, opts?: LoadJobOptions): Promise<GroomingJob | null> {
    this.calls.push(`loadJob:${bookingId}:${opts?.includeDeleted ?? false}`);
    return {
      bookingId,
      organizationId: toId<OrganizationId>("00000000-0000-4000-8000-000000000001"),
      branchId: toId<BranchId>("00000000-0000-4000-8000-0000000000a1"),
      pets: [],
    };
  }
  async addPet(i: { bookingId: BookingId; petId: PetId; isRequired: boolean }): Promise<GroomingJobPetId> {
    this.calls.push(`addPet:${i.petId}:${i.isRequired}`);
    return toId<GroomingJobPetId>(`00000000-0000-4000-8000-00000000a0${++this.seq}`);
  }
  async removePet(i: { groomingJobPetId: GroomingJobPetId; reason: string }): Promise<void> {
    this.calls.push(`removePet:${i.groomingJobPetId}:${i.reason}`);
  }
  async addLine(i: { groomingJobPetId: GroomingJobPetId; serviceId: ServiceId; quantity: number }): Promise<LineId> {
    this.calls.push(`addLine:${i.serviceId}:${i.quantity}`);
    return toId<LineId>(`00000000-0000-4000-8000-00000000b0${++this.seq}`);
  }
  async setLineQuantity(i: { lineId: LineId; quantity: number }): Promise<void> {
    this.calls.push(`setLineQuantity:${i.lineId}:${i.quantity}`);
  }
  async voidLine(i: { lineId: LineId; reason: string }): Promise<void> {
    this.calls.push(`voidLine:${i.lineId}:${i.reason}`);
  }
  async assignPetResource(i: { groomingJobPetId: GroomingJobPetId; resourceId: ResourceId }): Promise<void> {
    this.calls.push(`assignPetResource:${i.groomingJobPetId}:${i.resourceId}`);
  }
}

function ctx(opts: { perms: string[]; modules: string[]; branches: string[] }): PlatformContext {
  return {
    userId: toId<UserId>("00000000-0000-4000-8000-0000000000c1"),
    organizationId: toId<OrganizationId>("00000000-0000-4000-8000-000000000001"),
    membershipId: toId<MembershipId>("00000000-0000-4000-8000-0000000000d1"),
    isPlatformAdmin: false,
    permissions: new Set(opts.perms as PermissionKey[]),
    modules: new Set(opts.modules as ModuleKey[]),
    features: new Set(),
    branches: new Set(opts.branches.map((b) => toId<BranchId>(b))),
    metadata: { transport: "api", at: new Date() },
  };
}

const BOOKING = toId<BookingId>("00000000-0000-4000-8000-00000000ba01");
const BRANCH_A = "00000000-0000-4000-8000-0000000000a1";
const BRANCH_B = "00000000-0000-4000-8000-0000000000b2";
const PET = toId<PetId>("00000000-0000-4000-8000-0000000000f1");
const SVC = toId<ServiceId>("00000000-0000-4000-8000-000000005001");
const RES = toId<ResourceId>("00000000-0000-4000-8000-0000000e5001");

async function main() {
  const repo = new InMemoryGroomingRepo();
  const svc = new BookingAssemblyService({ grooming: repo });
  const authd = ctx({ perms: [PERMISSIONS.BOOKING_UPDATE, PERMISSIONS.BOOKING_READ], modules: [MODULES.SCHEDULING], branches: [BRANCH_A] });

  const r1 = await svc.addPet(authd, { bookingId: BOOKING, petId: PET, branchId: toId<BranchId>(BRANCH_A) });
  ok(r1.ok && repo.calls.some((c) => c.startsWith("addPet:")), "1 authorized addPet delegates to repo/RPC");

  const gjp = r1.ok ? r1.value.groomingJobPetId : (undefined as unknown as GroomingJobPetId);
  const r2 = await svc.addLine(authd, { groomingJobPetId: gjp, serviceId: SVC, branchId: toId<BranchId>(BRANCH_A) });
  ok(r2.ok && repo.calls.some((c) => c === "addLine:" + SVC + ":1"), "2 addLine defaults quantity to 1");

  const r3 = await svc.addPet(ctx({ perms: [PERMISSIONS.BOOKING_UPDATE], modules: [], branches: [BRANCH_A] }), { bookingId: BOOKING, petId: PET, branchId: toId<BranchId>(BRANCH_A) });
  ok(!r3.ok && (r3.error as { details?: { reason?: string } }).details?.reason === "missing_module:scheduling", "3 missing module denied");

  const r4 = await svc.addPet(ctx({ perms: [PERMISSIONS.BOOKING_UPDATE], modules: [MODULES.SCHEDULING], branches: [BRANCH_B] }), { bookingId: BOOKING, petId: PET, branchId: toId<BranchId>(BRANCH_A) });
  ok(!r4.ok && (r4.error as { details?: { reason?: string } }).details?.reason === "wrong_branch", "4 wrong-branch denied");

  const r5 = await svc.addPet(ctx({ perms: [PERMISSIONS.BOOKING_READ], modules: [MODULES.SCHEDULING], branches: [BRANCH_A] }), { bookingId: BOOKING, petId: PET, branchId: toId<BranchId>(BRANCH_A) });
  ok(!r5.ok && (r5.error as { details?: { reason?: string } }).details?.reason === "missing_permission:booking.update", "5 missing permission denied");

  const before = repo.calls.length;
  const r6 = await svc.voidLine(authd, { lineId: toId<LineId>("00000000-0000-4000-8000-00000000b001"), reason: "  ", branchId: toId<BranchId>(BRANCH_A) });
  ok(!r6.ok && r6.error.code === "BUSINESS_RULE" && repo.calls.length === before, "6 voidLine without reason -> BUSINESS_RULE, no RPC");

  const r7 = await svc.setLineQuantity(authd, { lineId: toId<LineId>("00000000-0000-4000-8000-00000000b001"), quantity: 0, branchId: toId<BranchId>(BRANCH_A) });
  ok(!r7.ok && r7.error.code === "BUSINESS_RULE", "7 setLineQuantity(0) -> BUSINESS_RULE");

  const repoThatThrows = (thrown: { code: string; message: string }): GroomingRepository => {
    const base = new InMemoryGroomingRepo();
    base.addPet = async () => { throw thrown; };
    return base;
  };
  const r8 = await new BookingAssemblyService({ grooming: repoThatThrows({ code: "42501", message: "wrong_branch" }) })
    .addPet(authd, { bookingId: BOOKING, petId: PET, branchId: toId<BranchId>(BRANCH_A) });
  ok(!r8.ok && r8.error.code === "AUTHORIZATION", "8 repo 42501 -> AUTHORIZATION");

  const r9 = await new BookingAssemblyService({ grooming: repoThatThrows({ code: "23505", message: "pet_already_on_booking" }) })
    .addPet(authd, { bookingId: BOOKING, petId: PET, branchId: toId<BranchId>(BRANCH_A) });
  ok(!r9.ok && r9.error.code === "CONFLICT", "9 repo 23505 -> CONFLICT");

  // 10 pet_customer_mismatch (business rule from DB) maps to BUSINESS_RULE
  const r10 = await new BookingAssemblyService({ grooming: repoThatThrows({ code: "23514", message: "pet_customer_mismatch" }) })
    .addPet(authd, { bookingId: BOOKING, petId: PET, branchId: toId<BranchId>(BRANCH_A) });
  ok(!r10.ok && r10.error.code === "BUSINESS_RULE", "10 repo pet_customer_mismatch -> BUSINESS_RULE");

  // 11 assignPetResource authorized delegates to repo
  const r11 = await svc.assignPetResource(authd, { groomingJobPetId: gjp, resourceId: RES, branchId: toId<BranchId>(BRANCH_A) });
  ok(r11.ok && repo.calls.some((c) => c.startsWith("assignPetResource:")), "11 assignPetResource delegates to repo/RPC");

  // 12 getJob returns an EMPTY job (not NOT_FOUND) for a booking with zero pets
  const r12 = await svc.getJob(authd, { bookingId: BOOKING, branchId: toId<BranchId>(BRANCH_A) });
  ok(r12.ok && r12.value.pets.length === 0 && r12.value.branchId === BRANCH_A, "12 getJob returns empty job with real branchId (item 5)");

  console.log(`\n${passed} assertions passed.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
