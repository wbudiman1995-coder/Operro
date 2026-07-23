# Operro Batch 2 — Final Independent Audit Report

Audit date: 2026-07-22

## Verdict

**NOT APPROVED**

The repository defects identified in the handoff were corrected, and no concrete application, migration, tenant, package-lifecycle, or concurrency logic defect was found during the independent source audit. However, this session could not complete the mandatory exact fresh-extraction rerun because:

1. PostgreSQL/`psql` is not installed in the execution environment.
2. The configured package gateway returned HTTP 503, so the required `npm ci` could not complete.

Therefore this report does **not** claim merge-readiness. Approval requires rerunning `bash run_all_gates.sh` from a fresh extraction in an environment with Node/npm package access and PostgreSQL 16, then retaining the raw output.

## Concrete corrections made

- `run_all_gates.sh`
  - enabled `set -euo pipefail`;
  - replaced `npm install` with `npm ci`;
  - preserved and propagated the actual TypeScript exit code;
  - made database setup, migration, seed, integration, and concurrency failures fatal;
  - asserted the exact 15-file migration lineage and eight assembly functions;
  - made the authenticator role password setup repeatable.
- `docs/EXECUTION_COMMANDS.md`
  - corrected the checksum filename;
  - creates extraction destinations before `tar -C`;
  - includes the preset-contract test;
  - uses `npm ci` and repeatable authenticator setup.
- `docs/BATCH2_IMPACT_INVENTORY.md`
  - corrected the human-run remote gate reference.
- `supabase/tests/concurrency/run_concurrency_assembly.sh`
  - explicitly fails when concurrency fixture reset fails instead of continuing with stale state.

No application source, frozen migration, migration `20260721001350`, SQL assertion, integration fixture, or domain contract was modified in this final session.

## Independent audit findings

- Frozen migrations `20260721000100` through `20260721001300`, including compatibility migration `20260721000150`, are byte-identical to the supplied canonical repository.
- Migration lineage contains exactly 15 files and ends at `20260721001350_grooming_assembly_operations.sql`.
- No migration 0014 file or skeleton exists.
- Obsolete `0100_grooming_assembly_operations.sql` is absent.
- Pet removal remains a permanent soft-delete lifecycle with stable `pet_removal_is_permanent` behavior.
- Authenticated integration uses `SET LOCAL ROLE authenticated` and covers `reserve_package_session`.
- The stale reservation regression constructs three stale-but-still-`reserved` rows, proves availability is zero, and then proves reservation succeeds after expiration processing.
- The three concurrency cases cover completion versus quantity change, line void, and package reservation.
- Synthetic failure injection proves the corrected runner propagates TypeScript and database setup failures, and the concurrency harness propagates fixture-reset failure.

## Gate status

| Gate | Required command / evidence | Result in this session | Count |
|---|---|---:|---:|
| Dependency install | `npm ci` | **BLOCKED** — package gateway HTTP 503 | — |
| Strict TypeScript | exact locked TypeScript command | **NOT COMPLETED EXACTLY**; contingency TypeScript 5.8.3 check passed | — |
| Workspace build | workspace build + six entry points | **CONTINGENCY PASS** with TypeScript 5.8.3 | 6 entry points |
| In-memory service | `npx tsx ...assembly_service...` | **CONTINGENCY PASS** via emitted JS | 12/12 |
| Preset contract | `npx tsx ...preset_contract...` | **CONTINGENCY PASS** via emitted JS | 13/13 |
| PostgreSQL migration | fresh PostgreSQL 16 apply | **NOT RERUN** — PostgreSQL unavailable | 15 files expected |
| Assembly RPC | SQL test | **NOT RERUN**; supplied canonical log records PASS | 17 expected |
| Reservation regression | SQL test | **NOT RERUN**; supplied canonical log records PASS | 18 expected |
| Authenticated integration | real `authenticator` login | **NOT RERUN**; supplied canonical log records PASS | 11 expected |
| Concurrency | three completion races | **NOT RERUN**; supplied canonical log records PASS | 3 expected |
| Failure propagation | synthetic fault injection | **PASS** | 3 cases |
| Patch hygiene | self-reference, forbidden paths, reverse/apply checks | **PASS** | — |
| Tree/archive verification | checksums and clean extraction | **PASS** | — |

The canonical supplied logs are retained as historical evidence, but they are not represented as an independent rerun by this session.

## Explicitly not performed

- Supabase remote push of migration `20260721001350`.
- PostgREST HTTP integration.
- Vercel deployment.
- Migration 0014.

## Approval action

From a fresh extraction, in an environment with PostgreSQL 16 and working npm access:

```bash
bash run_all_gates.sh 2>&1 | tee logs/extraction_rerun.log
```

Only after that command exits zero and prints `ALL GATES PASSED` should the verdict be changed to `APPROVED / MERGE-READY`.
