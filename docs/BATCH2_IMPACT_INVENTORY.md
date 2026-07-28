# BATCH2_IMPACT_INVENTORY.md — correction & completion pass

Scope: the grooming BookingAssembly vertical slice, corrected to merge-ready.
No migration 0014. 0013 file untouched (the applied migration is copied read-only
into `supabase/migrations/`; all corrections live in the new 01350 migration).

## Database (supabase/migrations/20260721001350_grooming_assembly_operations.sql)

| Object | Change | Item |
|---|---|---|
| `app.assembly_guard` | booking = LOCK 1 (booking→pet→line order) | 7 |
| `app.assembly_add_pet` | pet must be in booking org AND booking.customer_id → `pet_customer_mismatch` | 1 |
| `app.assembly_remove_pet` | release active package reservations on child lines (status=released, released_at=now()) before soft-delete; idempotent; booking-first lock | 2, 7 |
| `app.assembly_add_line` | only `is_active` + not-deleted + same-org catalog; snapshot name/base_price/currency/**duration_minutes** (no silent 60) | 3 |
| `app.assembly_set_line_quantity` | resolve booking w/o lock → guard → lock line; reject realized effects; reject any package-reservation row (`line_has_package_reservation`) | 7, 8 |
| `app.assembly_void_line` | booking-first lock; release active reservation; soft-delete | 7 |
| `app.assembly_assign_pet_resource` | NEW: branch-authorized per-pet groomer; resource same-org/active/not-deleted; reassignment audited | 4 |
| `app.reserve_package_session` | create-or-replace: reject quantity<>1 (`package_requires_unit_quantity`); 0013 file NOT edited | 8 |
| grants | 6 assembly ops + reserve to `authenticated`; guard/audit internal; PUBLIC stripped | — |

## Packages

| File | Change | Item |
|---|---|---|
| `packages/preset-grooming/src/assembly.ts` | branded SDK ids (not `Uuid=string`); `ASSEMBLY_RPC`/`ASSEMBLY_GATE`/`toRpcArgs`/`ASSEMBLY_ERRORS`; +assignPetResource | 6 |
| `packages/backend/src/services/BookingAssemblyService.ts` | import gate/types from preset (no local dup); **TimelinePort removed** (DB audits, no double-log); +assignPetResource; +getJob | 6 |
| `packages/backend/src/repositories/grooming.ts` | loadJob derives REAL org/branch from the booking (no `"" as BranchId`); boundary validation (no blind casts); empty booking → empty GroomingJob (not NotFound); live-only default + `includeDeleted` history read; RPCs via preset contract | 5, 6 |
| `packages/backend/test/assembly_service.inmemory.test.ts` | 12 assertions incl assignPetResource, empty-job, pet_customer_mismatch mapping | 5, 6 |

## Filename / packaging

| Item | Change |
|---|---|
| 9 | production migration named `20260721001350_grooming_assembly_operations.sql`; "0100" kept as internal doc label only |
| 10 | real repository tree (packages/, supabase/, integration/, docs/); root workspace package.json + tsconfig; checksums; clean patch; archive; no `mnt/user-data/...` paths |

## Not done (explicitly out of scope)
- Migration 0014 (governed support access) — NOT started; no skeleton in this bundle.
- Supabase remote push / PostgREST HTTP (Gate 11) — human-run; no remote creds here.
