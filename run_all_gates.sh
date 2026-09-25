#!/usr/bin/env bash
# run_all_gates.sh — full gate suite for the Batch 2 grooming bundle.
# Run from the repository root. The script exits immediately on any failed
# critical command and prints a final success marker only after every gate passes.
#
# Requirements: Node 20+/npm and PostgreSQL 16. By default the database gates
# connect to the local-only PostgreSQL container on 127.0.0.1:54322. Override
# the PG* variables when running against another disposable development server.
set -euo pipefail

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-54322}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export RUN_AS_POSTGRES="${RUN_AS_POSTGRES:-0}"

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
  supabase/migrations/20260721001400_active_organization_context.sql
  supabase/migrations/20260910120000_audit_log_read_api.sql
  supabase/migrations/20260916150000_customer_program_tenant_isolation.sql
  supabase/migrations/20260917100000_customer_addresses.sql
  supabase/migrations/20260917100100_branch_service_areas.sql
  supabase/migrations/20260917100200_booking_location_snapshot.sql
  supabase/migrations/20260917100300_batch_permissions.sql
  supabase/migrations/20260918130000_grooming_evidence_storage.sql
  supabase/migrations/20260918140000_booking_series_engine.sql
  supabase/migrations/20260918150000_resource_weekly_availability.sql
  supabase/migrations/20260918160000_customer_self_onboarding.sql
  supabase/migrations/20260918170000_styling_references.sql
  supabase/migrations/20260918180000_onboarding_styling_uploads.sql
  supabase/migrations/20260919100000_onboarding_settings_cleanup.sql
  supabase/migrations/20260919110000_complimentary_next_booking.sql
  supabase/migrations/20260919120000_calendar_bulk_actions.sql
  supabase/migrations/20260922100000_booking_package_coverage.sql
  supabase/migrations/20260922110000_booking_series_controls.sql
  supabase/migrations/20260922120000_branch_availability_controls.sql
  supabase/migrations/20260922130000_safe_booking_archive.sql
  supabase/migrations/20260922140000_attendance_tracking.sql
  supabase/migrations/20260924100000_complaint_lifecycle.sql
  supabase/migrations/20260924110000_complaint_rpc_only_writes.sql
  supabase/migrations/20260924120000_invoice_workflow.sql
  supabase/migrations/20260924130000_service_size_pricing.sql
  supabase/migrations/20260924140000_invoice_discounts_charges.sql
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
  "create schema if not exists auth; create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb); create schema if not exists storage; create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table if not exists storage.objects(id uuid, bucket_id text, name text); create or replace function storage.foldername(name text) returns text[] language sql immutable as \$\$ select string_to_array(name, '/') \$\$; do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$;"
psql_db operro_gate -q -v ON_ERROR_STOP=1 -f integration/gate_bootstrap_extensions.sql
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
  "do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role operro_gate_client login noinherit; exception when duplicate_object then null; end \$\$; alter role operro_gate_client login noinherit password 'stagingpw'; grant anon to operro_gate_client; grant authenticated to operro_gate_client; grant usage on schema public, app to anon, authenticated;"
psql_db operro_gate -q -v ON_ERROR_STOP=1 -f integration/0100_integration_seed.sql
PGPASSWORD=stagingpw psql \
  "host=$PGHOST port=$PGPORT dbname=operro_gate user=operro_gate_client" \
  -v ON_ERROR_STOP=1 \
  -f integration/0100_integration_client.sql

step "GATE 8 — completion vs assembly/reservation concurrency"
run_as_postgres dropdb --if-exists operro_cc
run_as_postgres createdb operro_cc
psql_db operro_cc -q -v ON_ERROR_STOP=1 -c \
  "create schema if not exists auth; create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb); create schema if not exists storage; create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table if not exists storage.objects(id uuid, bucket_id text, name text); create or replace function storage.foldername(name text) returns text[] language sql immutable as \$\$ select string_to_array(name, '/') \$\$; do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$;"
psql_db operro_cc -q -v ON_ERROR_STOP=1 -f integration/gate_bootstrap_extensions.sql
for migration in "${EXPECTED_MIGRATIONS[@]}"; do
  psql_db operro_cc -q -v ON_ERROR_STOP=1 -f "$migration"
done
psql_db operro_cc -q -v ON_ERROR_STOP=1 -f supabase/tests/concurrency/conc_seed.sql
CONC_TMP="$(mktemp -d /tmp/operro-concurrency.XXXXXX)"
trap 'rm -rf "$CONC_TMP"' EXIT

cp -a supabase/tests/concurrency/. "$CONC_TMP/"
chmod -R a+rX "$CONC_TMP"

run_as_postgres env DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/operro_cc" \
  bash "$CONC_TMP/run_concurrency_assembly.sh"

rm -rf "$CONC_TMP"
trap - EXIT

echo ""
echo "ALL GATES PASSED"
