# Execution commands — Batch 2 (no placeholders; copy-paste runnable)

All commands assume: repository root as CWD, PostgreSQL 16 reachable as a role
that can create databases, and the `postgres` OS user for local peer auth.
Node 22 + npm for the TypeScript gates.

## Gate 1 — strict root TypeScript typecheck
```bash
npm ci
npx tsc -p tsconfig.typecheck.json --noEmit --pretty false
```

## Gate 2 — build every workspace package (project references)
```bash
npm run build --workspaces --if-present
# verify emitted targets:
ls packages/sdk/dist/index.js packages/sdk/dist/index.d.ts
ls packages/preset-grooming/dist/index.js packages/preset-grooming/dist/index.d.ts
ls packages/backend/dist/index.js packages/backend/dist/index.d.ts
```

## Gate 3 — in-memory + preset-contract tests
```bash
npx tsx packages/backend/test/assembly_service.inmemory.test.ts
npx tsx packages/backend/test/preset_contract.test.ts
```

## Gate 4 — fresh PostgreSQL 16 apply using the approved timestamped sequence
(includes the UUIDv7 Supabase compatibility migration 20260721000150)
```bash
dropdb --if-exists operro_gate
createdb operro_gate
psql operro_gate -v ON_ERROR_STOP=1 -c "create schema if not exists auth; create table if not exists auth.users(id uuid primary key); do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$;"
for f in \
  supabase/migrations/20260721000100_extensions_and_helpers.sql \
  supabase/migrations/20260721000150_fix_uuidv7_supabase.sql \
  supabase/migrations/20260721000200_identity_access.sql \
  supabase/migrations/20260721000300_platform_entitlements.sql \
  supabase/migrations/20260721000400_commercial_core.sql \
  supabase/migrations/20260721000500_scheduling_core.sql \
  supabase/migrations/20260721000600_inventory_tasks.sql \
  supabase/migrations/20260721000700_customer_programs.sql \
  supabase/migrations/20260721000800_financial_sales.sql \
  supabase/migrations/20260721000900_payroll_expenses.sql \
  supabase/migrations/20260721001000_security_rls_isolation.sql \
  supabase/migrations/20260721001100_security_rls_capabilities.sql \
  supabase/migrations/20260721001200_cross_cutting_services.sql \
  supabase/migrations/20260721001300_core_neutrality_grooming_lines.sql \
  supabase/migrations/20260721001350_grooming_assembly_operations.sql ; do
    psql operro_gate -v ON_ERROR_STOP=1 -f "$f"
done
```

## Gate 5 — DB RPC tests (assembly operations)
```bash
psql operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20260721001350_test_assembly.sql
```

## Gate 6 — complete package-reservation regression tests
```bash
psql operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20260721001350_test_reservation.sql
```

## Gate 7 — real authenticated-role integration tests
```bash
psql operro_gate -v ON_ERROR_STOP=1 -c "do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticator login noinherit; exception when duplicate_object then null; end \$\$; alter role authenticator login noinherit password 'stagingpw'; grant anon to authenticator; grant authenticated to authenticator; grant usage on schema public, app to anon, authenticated;"
psql operro_gate -v ON_ERROR_STOP=1 -f integration/0100_integration_seed.sql
PGPASSWORD=stagingpw psql "host=127.0.0.1 port=5432 dbname=operro_gate user=authenticator" -v ON_ERROR_STOP=1 -f integration/0100_integration_client.sql
```

## Gate 8 — completion-vs-assembly/reservation concurrency
```bash
dropdb --if-exists operro_cc
createdb operro_cc
psql operro_cc -v ON_ERROR_STOP=1 -c "create schema if not exists auth; create table if not exists auth.users(id uuid primary key); do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$;"
for f in $(ls supabase/migrations/*.sql | sort); do psql operro_cc -v ON_ERROR_STOP=1 -f "$f"; done
psql operro_cc -v ON_ERROR_STOP=1 -f supabase/tests/concurrency/conc_seed.sql
DATABASE_URL="postgresql:///operro_cc" bash supabase/tests/concurrency/run_concurrency_assembly.sh
```

## Gate 9 — checksum verification
```bash
sha256sum -c docs/CHECKSUMS_AFTER_EXTRACTION.sha256
```

## Gate 10 — fresh archive extraction and rerun
```bash
rm -rf /tmp/verify
mkdir -p /tmp/verify
tar -xzf operro_batch2_repo.tar.gz -C /tmp/verify
cd /tmp/verify/operro-grooming-batch2
# re-run gates 1-8 above from the extracted tree
```

## Gate 11 (human-run) — Supabase remote push + PostgREST HTTP
NOT performed here (no remote credentials in this environment). On a disposable
Supabase project:
```bash
supabase db push        # applies the 20260721* timestamped migration tree in order
# then exercise the REST endpoints per docs/BATCH2_PLAN.md
```

## One-shot fresh-extraction rerun (recommended for reviewers)
```bash
rm -rf /tmp/operro-batch2-review
mkdir -p /tmp/operro-batch2-review
tar -xzf operro_batch2_repo.tar.gz -C /tmp/operro-batch2-review
cd /tmp/operro-batch2-review/operro-grooming-batch2
bash run_all_gates.sh          # runs gates 1-8; exits nonzero on any failure
```
The captured output of exactly this run is in `logs/extraction_rerun.log`.

## Checksums
```bash
# tree (run from the extracted root):
sha256sum -c docs/CHECKSUMS_AFTER_EXTRACTION.sha256
# the archive itself (run where the tar is):
sha256sum -c operro_batch2_repo.tar.gz.sha256
```
