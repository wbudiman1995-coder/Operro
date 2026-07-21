# INCREMENT1_STATUS.md

## Scope
Corrected **Batch 1** through the **FINAL SECURITY & INTEGRITY PASS**: migration
`0013` + executable tests + effects/eligibility scenario + **final-pass security
tests** + strict concurrency harness + positive & negative backfill harnesses +
**clean-room runner** + handoff docs. **No 0014. No migration 0014. No
SDK/backend edits. No UI. No Batch 2.**

## Evidence status — EXECUTED
All claims below are proven by execution against a real **PostgreSQL 16.14**
server, driven by the reproducible clean-room runner `run_clean_room.sh` (which
provisions fresh databases, applies `0001`–`0012` by explicit filename, and runs
every path to green, exiting nonzero on any failure). See
**TEST_EXECUTION_LOG.md** for version, timestamp, exact commands, checksums, and
per-step pass/fail counts. Items proven by execution are marked **[RUN]**.

## Final-pass corrections (the four production blockers + harness/runner/docs)
- **F1 — No direct client creation of authoritative records [RUN].** INSERT and
  DELETE revoked from `authenticated` on `grooming_job_pets`,
  `grooming_job_pet_services`, `package_reservations`; no table-level UPDATE on
  the line tables. Only SELECT + a narrow safe-column UPDATE
  (`grooming_job_pets`: status/instructions/warnings/preferences/metadata/audit;
  `grooming_job_pet_services`: duration_minutes/instructions/metadata/audit).
  Authoritative identity + commercial columns are not client-writable.
  **Targeted integrity patch:** `grooming_job_pet_services.quantity` (drives
  commission basis + inventory consumption) and BOTH tables' `deleted_at`
  (direct soft-delete would drop a required record from completion/commission/
  inventory/package effects) are now EXCLUDED from the UPDATE grants — revoking
  SQL DELETE alone was insufficient. Proven by `TCREATE1-3`, `TDEL1-3`,
  `TPROT1-4`, `TSAFE`/`TSAFE_LINE`, `TQTY_DENIED`/`TQTY_UNCHANGED`,
  `TSOFTDEL_PET`/`TSOFTDEL_LINE`, `TQTY_EFFECTS`.
- **F2 — Branch isolation on all grooming paths [RUN].** New tenant-only
  `app.tenant_has_branch()` (no admin bypass) + RESTRICTIVE branch RLS policies
  (SECTION 705) deriving branch via line → pet → booking; and
  `reserve_package_session` loads the booking branch into
  `assert_tenant_authorized`. A Branch-A-restricted user cannot read, update, or
  reserve against Branch-B records; `branches.all` sees both. Proven by
  `TBRANCH_READ_*`, `TBRANCH_UPD`, `TBRANCH_RESERVE`, `TBRANCH_RESERVE_OK`.
- **F3 — Release reservations on cancel/no_show [RUN].**
  `transition_booking_status` releases every active reservation on `canceled` /
  `no_show` in the same transaction (status → released, rows never deleted),
  restoring availability; idempotent (only 'reserved' rows touched, terminal
  states rejected); no silent consumption. Proven by `TREL_CANCEL`,
  `TREL_NOSHOW`, `TREL_IDEMP`.
- **F4 — Booking commercial caches database-controlled [RUN].**
  `service_name_snapshot` / `price_snapshot` / `currency` removed from
  `authenticated` INSERT and UPDATE grants on `bookings` (SECTION 610), so a
  client cannot create a cache-vs-line mismatch. Proven by `TCACHE_INS`,
  `TCACHE_UPD`.
- **F5 — Strict concurrency harness [RUN].** Session B now exits NONZERO; the
  harness checks `A_RC=0`, `B_RC≠0`, exactly one `no_sessions_available`, no
  other ERROR lines, exactly one reservation, and no duplicate ledger/reservation
  effect. **T11 PASS.**
- **F6 — Clean-room runner [RUN].** `run_clean_room.sh` builds fresh DBs, runs
  all paths, collects logs to `execution_logs/`, and exits nonzero on any
  failure (self-tested with an injected failure → exit 1).
- **F7 — Handoff refreshed & packaged.** Stale "pass 2 / not executed" headers
  updated; `TEST_EXECUTION_LOG.md` added; pass-3→final patch and repository
  archive produced.

## Pass-3 review items (the ten corrections)
1. **Atomic migration [RUN]** — the whole of `0013` is now wrapped in a single
   `begin; … commit;`. This was a *real* defect, not cosmetic: psql defaults to
   per-statement autocommit, so in pass 2 the SECTION 310 `raise` rolled back
   only its own `DO` block — SECTIONS 100–300 (new tables, backfill) had already
   committed. Demonstrated directly: applying the **unpatched pass-2** file to
   poison data leaves `grooming_job_pets`, `grooming_job_pet_services`,
   `package_reservations` behind; the **pass-3** file leaves nothing behind.
   There is deliberately **no** internal exception handler and **no** explicit
   `rollback`: an unhandled `raise` aborts the transaction, the trailing
   `commit` is rejected by the server, and psql (`-v ON_ERROR_STOP=1`) exits
   nonzero so the shell harness sees failure.
2. **Automatic abort for non-grooming legacy values [RUN]** — SECTION 310 now
   also counts bookings whose `booking_type <> 'grooming'` that still carry
   `pet_id`/`service_id`. SECTION 300 only backfills grooming rows, and SECTION
   320 dropped both columns unconditionally, so such rows would have been
   silently discarded. Any nonzero count now raises `BACKFILL ABORT`
   (`data_exception`) and rolls the whole migration back.
3. **Positive AND negative backfill harnesses [RUN]** — new directory
   `0013_backfill_harness/`:
   * `run_backfill_positive.sh` + `positive_seed.sql` + `positive_assert.sql` —
     seeds legacy singular-column grooming bookings, applies `0013`, asserts
     every legacy value (pet, service, price/name snapshots, completed→complete
     status, service-less booking → pet-only) migrated and the columns dropped.
     **8/8 assertions pass.**
   * `run_backfill_negative.sh` + `negative_seed.sql` + `negative_assert.sql` —
     seeds a poison non-grooming booking, applies `0013`, **requires** it to
     fail via `BACKFILL ABORT`, then opens a **fresh connection** and proves all
     pre-0013 schema, data, triggers, and functions are intact (columns still
     present, no new tables, no new functions, the six SECTION 000 drop-target
     functions survived, no new constraints/registrations). **8/8 assertions
     pass.**
4. **Explicit migration filenames [DONE]** — this document and `INDEX.md` /
   `MANIFEST.md` now list every file by exact name (no `0013_*` globs), and the
   apply loop enumerates `0001_extensions_and_helpers.sql … 0012_cross_cutting_
   services.sql … 0013_core_neutrality_grooming_lines.sql` explicitly. The
   harness directory is named `0013_backfill_harness/` (the pass-2 docs referred
   to a nonexistent `0013_concurrency/`; corrected here).
5. **Authenticated-role concurrency harness [RUN]** — `sessionA.sql` /
   `sessionB.sql` now `set local role authenticated` (pass 2 ran as superuser,
   which bypassed the client privilege path entirely). `run_concurrency.sh`
   writes its transient `A.out`/`B.out` to a `mktemp` dir (the script dir may be
   read-only for the OS user running psql) and now also asserts session A
   *succeeded*. Result: A reserves the single session; B blocks on the row lock,
   then is rejected with `no_sessions_available`; final reserved count = 1.
   **T11 PASS.**
6. **Real reversal-idempotency test [RUN]** — pass-2 T13b/T13c only *asserted
   the documented outcome* without ever calling the reversal function. The new
   T13b/T13c/T13d actually invoke `app.reverse_package_reservation` **twice** and
   prove: one compensating `+1 'adjustment'` ledger row is written and the
   reservation goes `released` with a `reversal_ledger_id`; a second call is a
   pure no-op (no extra row, unchanged `reversal_ledger_id`); exactly one
   lifecycle row survives; and the reversed line still cannot be re-reserved
   (`unique_violation`). **8 reversal assertions pass** within the 35-assertion
   suite.
7. **Locked authoritative-record creation & deletion [RUN]** — `DELETE` is
   revoked from `authenticated` on `grooming_job_pets` and
   `grooming_job_pet_services` (soft-delete via `deleted_at` is the only client
   path); `package_reservations.fk_pr_line` changed from `ON DELETE CASCADE` to
   `ON DELETE RESTRICT` so a line with any reservation history can never be
   silently deleted. Verified live: `has_table_privilege(... 'DELETE')` = false
   for both tables; `pg_constraint.confdeltype` = `r`.
8. **Explicit PUBLIC function revokes [RUN]** — Postgres grants `EXECUTE` to
   `PUBLIC` by default on `CREATE FUNCTION`; pass 2 granted the 4 client RPCs and
   3 `tenant_has_*` helpers to `authenticated` but never stripped the default
   `PUBLIC` grant, leaving them reachable by any role (incl. `anon`). SECTION 710
   now `revoke … from public` on each, then grants only `authenticated`. Verified
   live: `has_function_privilege('public','app.complete_booking…','execute')` =
   false; `('authenticated', …)` = true.
9. **Strengthened UUID validator [RUN]** — `validate_uuids.py` now scans every
   single- **and** double-quoted literal, reports near-misses the pass-2 version
   silently skipped (wrong segment lengths, non-hex characters), and enforces the
   RFC-4122 **version** (1–7) and **variant** (8/9/a/b) nibbles with an allow-list
   for the all-zero sentinel. Confirmed: passes all 441 real literals; catches
   all four defect classes on a crafted bad-input file (exit 1).
10. **Fully refreshed handoff docs [DONE]** — this file, `BACKFILL_REPORT.md`,
    `INDEX.md`, and `MANIFEST.md` are rewritten for pass 3 with the execution
    evidence, the new harness directory, and explicit filenames.

## Pass-2 items still in force (unchanged, re-verified [RUN])
Composite FK `uq_grooming_jobs_org_id`; `assert_tenant_authorized` on every RPC;
`package_available_sessions(uuid)` derives org; no `is_platform_admin` bypass on
new-table paths; reservation writes locked to SECURITY DEFINER RPCs; protected
line fields excluded from client `UPDATE`; skipped/incomplete → zero effects;
generic `transition_booking_status` refuses `completed`; `expire_package_
reservations` frees stale holds; no repair escape hatch (deferred to 0014);
commission source identity frozen.

## An extra pass-2 bug found while executing
The test fixture never granted `membership.read` to the Owner role, so `T10`
(`app.package_available_sessions`) failed with `missing_permission` the moment
the suite was actually run. Fixed in `0013_test_core_neutrality.sql`. This is
exactly the class of error that "authored but not executed" hides.

## Files in this batch (exact names)
Migration & tooling (apply/run from wherever you stage them):
- `0013_core_neutrality_grooming_lines.sql`  (1579 lines; 3 tables, 17 functions;
  `$$` balanced 38, `$f$` balanced 2)
- `0013_test_core_neutrality.sql`            (520 lines; 35 assertions)
- `0013_effects_eligibility_scenario.sql`    (87 lines; 6 assertions)
- `0013_test_security_final.sql`             (601 lines; 39 assertions — final-pass
  items 1–4: direct-write rejection, branch isolation, cancel/no_show release,
  booking-cache lockdown)
- `validate_uuids.py`                        (127 lines)
- `run_concurrency.sh`                       (99 lines; STRICT — item 5)
- `sessionA.sql`                             (15 lines)
- `sessionB.sql`                             (18 lines; ON_ERROR_STOP on → nonzero)
- `setup.sql`                                (29 lines; T11 fixture)
- `run_clean_room.sh`                        (195 lines; reproducible runner — item 6)

Backfill harness directory `0013_backfill_harness/`:
- `run_backfill_positive.sh`   (35 lines)
- `positive_seed.sql`          (50 lines)
- `positive_assert.sql`        (74 lines; 8 assertions)
- `run_backfill_negative.sh`   (57 lines)
- `negative_seed.sql`          (40 lines)
- `negative_assert.sql`        (84 lines; 8 assertions)

Docs: `INCREMENT1_STATUS.md` (this file), `BACKFILL_REPORT.md`,
`TEST_EXECUTION_LOG.md`, `INDEX.md`, `MANIFEST.md`.
Execution evidence: `execution_logs/` (per-step logs, CHECKSUMS.sha256, SUMMARY).

## Reproducible execution (clean-room runner)
```bash
# As the postgres OS user, from the artifact directory. Provisions FOUR fresh
# databases, applies 0001..0012 by explicit filename, runs every path, writes
# logs to execution_logs/<timestamp>/, and exits nonzero on ANY failure.
LOGDIR=./execution_logs/final bash run_clean_room.sh

# The runner performs, per fresh database:
#   uuid_validator → positive_backfill → negative_rollback → apply_0013 →
#   main_tests → effects_tests → security_tests → concurrency_T11 → checksums.
# Individual pieces can still be run standalone (see TEST_EXECUTION_LOG.md for
# the exact manual sequence the runner automates).
```

See **TEST_EXECUTION_LOG.md** for PostgreSQL version, timestamp, full command
list, file checksums, and per-step pass/fail counts.

## Results observed in this environment (PostgreSQL 16.14, clean-room `final` run)
- **[RUN]** `0001`–`0012` apply clean; `0013` applies clean on a valid baseline.
- **[RUN]** `validate_uuids.py`: 441 valid literals, version+variant enforced,
  exit 0; crafted bad-input file → exit 1 (4 defect classes caught).
- **[RUN]** `0013_test_core_neutrality.sql`: **35/35 PASS**, exit 0.
- **[RUN]** `0013_effects_eligibility_scenario.sql`: **6/6 PASS**, exit 0.
- **[RUN]** `0013_test_security_final.sql`: **39/39 PASS**, exit 0 (final-pass
  items 1–4).
- **[RUN]** `run_concurrency.sh`: **T11 PASS** — A_RC=0, B_RC≠0, exactly one
  `no_sessions_available`, no other ERROR lines, 1 reservation, no duplicate
  effects.
- **[RUN]** positive backfill: **8/8 PASS** (legacy data migrated, columns dropped).
- **[RUN]** negative backfill: **8/8 PASS** (abort fired, whole migration rolled
  back, fresh-connection integrity intact).
- **[RUN]** clean-room runner overall exit **0**; injected-failure self-test → exit 1.
- **[RUN]** live privilege checks: PUBLIC execute revoked / authenticated
  retained on RPCs; INSERT+DELETE revoked on all three grooming tables;
  line/pet UPDATE limited to safe columns; booking caches absent from
  INSERT/UPDATE grants; `fk_pr_line` = RESTRICT.
- **Total: 96 functional assertions passing, 0 failing.**

## What this does NOT claim
This is a local PostgreSQL 16 run, not your target environment. Re-run the same
commands against your Supabase/managed instance before promoting — RLS behaviour
under the real `authenticator`→`authenticated` JWT flow, and any extra NOT-NULL
columns on `subscriptions`/others, should be confirmed there. No 0014, SDK,
backend, or UI work is included or implied.
