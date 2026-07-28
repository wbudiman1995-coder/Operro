# Pet-removal behavior (v1)

## Decision: removal is permanent for v1

Removing a pet from a booking (`app.assembly_remove_pet`) is a **soft delete**:
the `grooming_job_pets` row is retained with `deleted_at` set (so history,
audit, and any released reservations are preserved).

The uniqueness index that guarantees one pet-per-booking —
`uq_gjp_job_pet (organization_id, grooming_job_id, pet_id)` — is **not** partial;
it spans soft-deleted rows. As a direct consequence, **a removed pet cannot be
added again to the same booking** in v1.

This is an intentional v1 constraint, not a bug. A controlled "restore" operation
(which would revive the soft-deleted row rather than insert a new one) is
deliberately out of scope for this increment.

## Stable, explicit error

`assembly_add_pet` detects the prior soft-deleted row and raises a stable,
documented business error rather than leaking the raw Postgres unique violation:

| Situation | Error (SQLSTATE 23514, check_violation) |
|---|---|
| Pet is currently on the booking (active row) | `pet_already_on_booking` |
| Pet was previously removed from this booking | `pet_removal_is_permanent` |

Both are part of the preset error contract (`ASSEMBLY_ERRORS`) and classify to
`BUSINESS_RULE`, so the service surfaces them as a `BusinessRuleError` with the
stable code, never as an opaque `23505`.

## Test coverage

`supabase/tests/20260721001350_test_assembly.sql` case **C16** adds a pet,
removes it, then asserts that re-adding the same pet to the same booking raises
`pet_removal_is_permanent` (and explicitly fails if a raw unique violation leaks
instead).

## Future work (not v1)

If product later needs re-add, the sanctioned path is a new controlled operation
`assembly_restore_pet(p_pet)` that clears `deleted_at` on the existing row under
the same booking→pet lock order and authorization, rather than relaxing the
unique index. That is explicitly deferred.
