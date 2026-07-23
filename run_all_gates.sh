#!/usr/bin/env bash
# run_all_gates.sh — full gate suite for the Batch 2 grooming bundle.
# Run from the repository root. The script exits immediately on any failed
# critical command and prints a final success marker only after every gate passes.
#
# Requirements: Node 20+/npm and PostgreSQL 16. RUN_AS_POSTGRES=1 (default)
# executes local database administration through the postgres OS user; set it to
# 0 when the current user already has the required PostgreSQL privileges.
set -euo pipefail

step() {
  echo ""
  echo "########## $* ##########"
}

run_as_postgres() {
  if [ "${RUN_AS_POSTGRES:-1}" = "1" ] && [ "$(id -un)" != "postgres" ]; then
    local command_string
    printf -v command_string '%q ' "$@"
    su -s /bin/bash postgres -c "$command_string"
  else
    "$@"
  fi
}

psql_db() {
  run_as_postgres psql "$@"
}

EXPECTED_MIGRATIONS=(
  supabase/migrations/20260721000100_extensions_and_helpers.sql
  supabase/migrations/20260721000150_fix_uuidv7_supabase.sql
  supabase/migrations/20260721000200_identity_access.sql
  supabase/migrations/20260721000300_platform_entitlements.sql
  supabase/migrations/20260721000400_commercial_core.sql
  supabase/migrations/20260721000500_scheduling_core.sql
  supabase/migrations/20260721000600_inventory_tasks.sql
  supabase/migrations/20260721000700_customer_programs.sql
  supabase/migrations/20260721000800_financial_sales.sql
  supabase/migrations/20260721000900_payroll_expenses.sql
  supabase/migrations/20260721001000_security_rls_isolation.sql
  supabase/migrations/20260721001100_security_rls_capabilities.sql
  supabase/migrations/20260721001200_cross_cutting_services.sql
  supabase/migrations/20260721001300_core_neutrality_grooming_lines.sql
  supabase/migrations/20260721001350_grooming_assembly_operations.sql
)
mapfile -t ACTUAL_MIGRATIONS < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print | sort)
if [ "$(printf '%s\n' "${EXPECTED_MIGRATIONS[@]}")" != "$(printf '%s\n' "${ACTUAL_MIGRATIONS[@]}")" ]; then
  echo "Migration lineage mismatch." >&2
  echo "Expected:" >&2
  printf '  %s\n' "${EXPECTED_MIGRATIONS[@]}" >&2
  echo "Actual:" >&2
  printf '  %s\n' "${ACTUAL_MIGRATIONS[@]}" >&2
  exit 1
fi

step "GATE 1 — strict TypeScript typecheck"
npm ci
npx tsc --version
if npx tsc -p tsconfig.typecheck.json --noEmit --pretty false; then
  echo "typecheck exit=0"
else
  rc=$?
  echo "typecheck exit=$rc" >&2
  exit "$rc"
fi

step "GATE 2 — workspace build"
npm run build --workspaces --if-present
ls -l \
  packages/sdk/dist/index.js \
  packages/sdk/dist/index.d.ts \
  packages/preset-grooming/dist/index.js \
  packages/preset-grooming/dist/index.d.ts \
  packages/backend/dist/index.js \
  packages/backend/dist/index.d.ts

step "GATE 3 — in-memory + preset-contract tests"
npx tsx packages/backend/test/assembly_service.inmemory.test.ts
npx tsx packages/backend/test/preset_contract.test.ts

step "GATE 4 — fresh PostgreSQL migrate (timestamped lineage incl 00150)"
run_as_postgres dropdb --if-exists operro_gate
run_as_postgres createdb operro_gate
psql_db operro_gate -q -v ON_ERROR_STOP=1 -c \
  "create schema if not exists auth; create table if not exists auth.users(id uuid primary key); do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$;"
for migration in "${EXPECTED_MIGRATIONS[@]}"; do
  psql_db operro_gate -q -v ON_ERROR_STOP=1 -f "$migration"
done
assembly_fns=$(psql_db operro_gate -tAc \
  "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and proname like 'assembly%';" | tr -d '[:space:]')
echo "assembly fns: $assembly_fns"
[ "$assembly_fns" = "8" ] || {
  echo "Expected 8 assembly functions, found $assembly_fns" >&2
  exit 1
}

step "GATE 5 — assembly RPC tests"
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20260721001350_test_assembly.sql

step "GATE 6 — package-reservation regression tests"
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20260721001350_test_reservation.sql

step "GATE 7 — real authenticated-role integration (incl reserve_package_session)"
psql_db operro_gate -q -v ON_ERROR_STOP=1 -c \
  "do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticator login noinherit; exception when duplicate_object then null; end \$\$; alter role authenticator login noinherit password 'stagingpw'; grant anon to authenticator; grant authenticated to authenticator; grant usage on schema public, app to anon, authenticated;"
psql_db operro_gate -q -v ON_ERROR_STOP=1 -f integration/0100_integration_seed.sql
PGPASSWORD=stagingpw psql \
  "host=127.0.0.1 port=5432 dbname=operro_gate user=authenticator" \
  -v ON_ERROR_STOP=1 \
  -f integration/0100_integration_client.sql

step "GATE 8 — completion vs assembly/reservation concurrency"
run_as_postgres dropdb --if-exists operro_cc
run_as_postgres createdb operro_cc
psql_db operro_cc -q -v ON_ERROR_STOP=1 -c \
  "create schema if not exists auth; create table if not exists auth.users(id uuid primary key); do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$;"
for migration in "${EXPECTED_MIGRATIONS[@]}"; do
  psql_db operro_cc -q -v ON_ERROR_STOP=1 -f "$migration"
done
psql_db operro_cc -q -v ON_ERROR_STOP=1 -f supabase/tests/concurrency/conc_seed.sql
run_as_postgres env DATABASE_URL='postgresql:///operro_cc' \
  bash supabase/tests/concurrency/run_concurrency_assembly.sh

echo ""
echo "ALL GATES PASSED"
