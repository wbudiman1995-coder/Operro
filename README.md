# Operro 0013 — Final Security & Integrity Pass (repository archive)

This archive contains migration `0013` (grooming vertical: core neutrality,
per-line effects, package reservations, secured completion) plus its complete,
**executed** test/harness suite and evidence. All work was run to green against
PostgreSQL 16.14 via the clean-room runner. No `0014`, SDK, backend, or UI work
is included.

## Layout

```
0013_core_neutrality_grooming_lines.sql   the migration (atomic BEGIN/COMMIT)
0013_test_core_neutrality.sql             main suite (35 assertions)
0013_effects_eligibility_scenario.sql     skipped/override effects (6)
0013_test_security_final.sql              final-pass security suite (30)
validate_uuids.py                         strict UUID gate
run_concurrency.sh + sessionA/B.sql + setup.sql   strict T11 concurrency
run_clean_room.sh                         reproducible end-to-end runner
0013_backfill_harness/                    positive (8) + negative/atomicity (8)
migrations/                               0001–0012 base engine (dependencies)
execution_logs/                           raw per-step outputs + CHECKSUMS
INCREMENT1_STATUS.md, BACKFILL_REPORT.md, TEST_EXECUTION_LOG.md, INDEX.md,
MANIFEST.md                               handoff docs
pass3_to_final.patch                      pass-3 -> final unified diff
```

## Reproduce (PostgreSQL 16; run as a role that can create databases)

```bash
# From this directory, as the postgres OS user (local peer auth), or set
# URLBASE / PSQL / CREATEDB / DROPDB for your environment.
LOGDIR=./execution_logs/rerun bash run_clean_room.sh
```

The runner provisions four fresh databases, applies `0001`–`0012` by explicit
filename, then runs: uuid gate, positive backfill, negative rollback, apply
`0013`, main tests, effects tests, security tests, and authenticated concurrency
— writing logs under `LOGDIR` and exiting nonzero on any failure.

## Status

96 functional assertions pass (35 main + 6 effects + 39 security + 8 positive +
8 negative backfill), plus the strict T11 concurrency check. The final targeted
integrity patch removed `quantity` and `deleted_at` from the authenticated
UPDATE grants (they drive commission/inventory effects and completion
eligibility). See `TEST_EXECUTION_LOG.md` for version, timestamp, commands,
checksums, counts, and the Supabase re-verification still required before
promotion; `targeted_integrity_patch.patch` isolates that final change.
