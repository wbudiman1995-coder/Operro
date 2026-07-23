# Batch 2 — BookingAssembly (correction pass 2 — merge-readiness)

All 9 blockers from the review applied to the real files; all local gates pass on
PostgreSQL 16.14. Approved Supabase timestamped migration lineage restored. No
migration 0014 (its skeleton was removed from the deliverable).

## Blockers resolved
1. Timestamped lineage `20260721000100..001300` + `000150_fix_uuidv7_supabase` +
   `001350_grooming_assembly_operations`. No shortened 0001–0013 filenames ship.
2. `reserve_package_session` retains ALL frozen-0013 protections (package
   existence/active/expiration/service-applicability/customer-match/stale-expiry/
   error names/oversubscription) + adds quantity=1 + booking-lifecycle
   serialization (booking-first lock, refuse if not open).
3. `assembly_assign_pet_resource` requires resource org+branch match, active,
   not deleted; cross-branch negative test added.
4. `@operro/preset-grooming` is the single operation contract; backend imports
   its input types/gate/RPC map (no local duplication).
5. Workspace build via TypeScript project references; `npm run build
   --workspaces --if-present` passes; `packages/backend/src/index.ts` added;
   main/types/exports generated for every package.
6. Package-reservation regression: quantity≠1/=1, lifecycle (reserved/consumed/
   released/reversed/expired) quantity-change rejection, expired package, service
   mismatch, customer mismatch, stale-hold expiry, completion race, real role.
7. Concurrency: Session B ON_ERROR_STOP=1 + asserts frozen-booking rejection;
   no deadlock, A succeeds, B blocks until A commits, B rejected, state correct;
   three cases (set-qty, void, reserve) vs complete_booking.
8. Clean patch (`docs/batch2_correction.patch`): frozen migrations shown as
   renames, obsolete 0100 file gone, only the intended delta.
9. `docs/EXECUTION_COMMANDS.md` fully runnable, no placeholders; raw logs in logs/.

## Completion gate results (correction pass 2, all re-run on PostgreSQL 16.14)

1. TypeScript strict typecheck — PASS (exit 0; real stdout/stderr captured in logs/gate1_typecheck.log)
2. Workspace build (`tsc -b` project refs) — PASS; dist main/types emitted for all 3 packages
3. In-memory service tests — 12/12 PASS
4. Preset-contract tests — 13/13 PASS
5. Fresh PG16 migrate (timestamped lineage incl 000150 UUIDv7 compat) — clean; 8 assembly fns
6. Assembly RPC tests — 17/17 PASS (adds C16 permanent-removal)
7. Package-reservation regression — 18/18 PASS (R7 rewritten; mutation-verified: fails if expire call removed)
8. Real authenticated-role integration — 11/11 PASS (adds I8–I11 reserve_package_session via authenticated login role)
9. Concurrency — CONC PASS (complete vs set-qty / void / reserve; no deadlock)
10. Fresh-extraction rerun of the archive — ALL GATES PASSED (logs/extraction_rerun.log)
11. Supabase remote push / PostgREST HTTP — HUMAN-RUN (not performed here; no remote creds)


## Not in scope
- Migration 0014 (governed support access) — not started; skeleton removed.
- Preset breadth, GroomingBookingService composition, zod edge validation.
