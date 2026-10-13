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
  supabase/migrations/20260925100000_package_membership_lifecycle.sql
  supabase/migrations/20260926090000_membership_renewal_billing_and_reconciliation.sql
  supabase/migrations/20260927090000_membership_revision_null_guards.sql
  supabase/migrations/20260927100000_visit_register.sql
  supabase/migrations/20260928100000_payment_control_workflow.sql
  supabase/migrations/20260929100000_grooming_evidence_hardening.sql
  supabase/migrations/20260930100000_invoice_documents.sql
  supabase/migrations/20261001100000_payment_workflow_closeout.sql
  supabase/migrations/20261002090000_retention_renewal_followups.sql
  supabase/migrations/20261002100000_payment_visit_register_pagination.sql
  supabase/migrations/20261003100000_storage_authorization_review.sql
  supabase/migrations/20261010100000_payroll_engine_s32.sql
  supabase/migrations/20261010110000_payroll_engine_s32_rpcs.sql
  supabase/migrations/20261010120000_payroll_export_detail_rpc.sql
  supabase/migrations/20261012100000_invoice_number_random_suffix.sql
  supabase/migrations/20261013100000_payroll_recompute_race_lock.sql
  supabase/migrations/20261013110000_uuidv7_authenticated_defaults.sql
  supabase/migrations/20261014100000_payroll_retention_ledger_idempotent.sql
  supabase/migrations/20261015100000_homepaw_owner_workspace_bootstrap.sql
  supabase/migrations/20261016100000_homepaw_customer_intake.sql
  supabase/migrations/20261016110000_zero_time_service_addons.sql
  supabase/migrations/20261017100000_homepaw_size_price_duration.sql
  supabase/migrations/20261017110000_homepaw_membership_tiers.sql
  supabase/migrations/20261018100000_onboarding_admin_amend.sql
  supabase/migrations/20261018110000_storage_usage_requests.sql
  supabase/migrations/20261018120000_onboarding_maps_link.sql
  supabase/migrations/20261019100000_platform_org_access.sql
  supabase/migrations/20261019110000_org_dog_size_boundaries.sql
  supabase/migrations/20261020100000_legacy_org_access_roles.sql
  supabase/migrations/20261020110000_platform_billing_invoices.sql
  supabase/migrations/20261020120000_custom_pet_types.sql
  supabase/migrations/20261022100000_platform_owner_workspace_access.sql
  supabase/migrations/20261022110000_customer_codes.sql
  supabase/migrations/20261023100000_size_band_tables.sql
  supabase/migrations/20261023110000_size_band_shadow_sync.sql
  supabase/migrations/20261023120000_size_band_resolver.sql
  supabase/migrations/20261023130000_size_band_integrity.sql
  supabase/migrations/20261024100000_size_band_management_rpcs.sql
  supabase/migrations/20261025100000_size_band_booking_customer_adapters.sql
  supabase/migrations/20261026100000_customer_pet_edit.sql
  supabase/migrations/20261027100000_size_band_payroll.sql
  supabase/migrations/20261028100000_org_export_foundation.sql
  supabase/migrations/20261028110000_dashboard_card_settings.sql
  supabase/migrations/20261029100000_custom_fields.sql
  supabase/migrations/20261029110000_pet_coat_profile.sql
  supabase/migrations/20261029120000_settings_and_preferences.sql
  supabase/migrations/20261029130000_finance_cash_position.sql
  supabase/migrations/20261029140000_whatsapp_drafts.sql
  supabase/migrations/20261029150000_audit_reconciliation.sql
  supabase/migrations/20261029160000_storage_cleanup_foundation.sql
  supabase/migrations/20261029170000_health_recovery.sql
  supabase/migrations/20261030100000_performance_dashboard.sql
  supabase/migrations/20261030110000_payroll_read_helper_hardening.sql
  supabase/migrations/20261031100000_dashboard_operational_alerts.sql
  supabase/migrations/20261031110000_cash_control_register.sql
  supabase/migrations/20261031120000_whatsapp_batch_log.sql
  supabase/migrations/20261031130000_export_scope_retention.sql
  supabase/migrations/20261031140000_business_settings.sql
  supabase/migrations/20261031150000_cleanup_schedule_consent.sql
  supabase/migrations/20261031160000_health_signals.sql
  supabase/migrations/20261101100000_marketing_spend_roi.sql
  supabase/migrations/20261101110000_cash_account_mappings.sql
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
npm exec --workspace apps/web -- tsx --test test/customer-code-contract.test.ts test/search-and-profile.test.ts test/audit-diff.test.ts test/finance-export.test.ts test/customer-bulk-edit-contract.test.ts test/customer-profile-edit.test.ts test/customer-pet-edit.test.ts test/size-bands.test.ts test/size-band-ui.test.tsx test/payroll-dynamic-size.test.ts test/dashboard-read-model.test.ts test/org-export-contract.test.ts test/catalog-actions-validation.test.ts test/control-plane-ui.test.tsx test/custom-fields.test.ts test/preferences.test.ts test/finance-cash.test.ts test/whatsapp-drafts.test.ts test/audit-reconciliation.test.ts test/storage-cleanup.test.ts test/health-recovery.test.ts test/remaining-nine-ui.test.tsx test/dashboard-period.test.ts test/dashboard-performance.test.tsx test/dashboard-alerts.test.tsx test/cash-register.test.tsx test/whatsapp-batches.test.tsx test/org-export-restore-plan.test.ts test/org-export-scope.test.tsx test/business-settings.test.tsx test/access-readiness.test.ts test/cleanup-schedule.test.tsx test/health-owner-actions.test.tsx test/marketing-spend.test.tsx test/cash-mapping.test.tsx

step "GATE 4 — fresh PostgreSQL migrate (timestamped lineage incl 00150)"
run_as_postgres dropdb --if-exists operro_gate
run_as_postgres createdb operro_gate
psql_db operro_gate -q -v ON_ERROR_STOP=1 -c \
  "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create schema if not exists auth; create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb); create or replace function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid \$\$; create schema if not exists storage; create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table if not exists storage.objects(id uuid, bucket_id text, name text, metadata jsonb); create or replace function storage.foldername(name text) returns text[] language sql immutable as \$\$ select string_to_array(name, '/') \$\$; do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$; grant usage on schema auth to authenticated;"
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

step "GATE 4b — customer-code and access-control contracts"
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261022110000_test_customer_code.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/customer_code/rls_smoke.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261021110000_test_audit_event_access.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261028110000_test_dashboard_card_settings.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261028100000_test_org_export.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029100000_test_custom_fields.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029110000_test_pet_coat_profile.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029120000_test_settings_and_preferences.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029130000_test_finance_cash_position.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029140000_test_whatsapp_drafts.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029150000_test_audit_reconciliation.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029155000_test_access_policy_regression.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029160000_test_storage_cleanup.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261029170000_test_health_recovery.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261030100000_test_performance_dashboard.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261030110000_test_payroll_read_helper_hardening.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031100000_test_dashboard_operational_alerts.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031110000_test_cash_control_register.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031120000_test_whatsapp_batch_log.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031130000_test_export_scope_retention.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031140000_test_business_settings.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031145000_test_invitation_claim.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031150000_test_cleanup_schedule_consent.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261031160000_test_health_signals.sql

step "GATE 4c — customer-code concurrency"
CC_TMP="$(mktemp -d /tmp/operro-customer-code.XXXXXX)"
trap 'rm -rf "$CC_TMP"' EXIT
cp -a supabase/tests/customer_code/. "$CC_TMP/"
find "$CC_TMP" -type f -exec sed -i 's/\r$//' {} +
chmod -R a+rX "$CC_TMP"
run_as_postgres env DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/operro_gate" \
  bash "$CC_TMP/run_customer_code_concurrency.sh"
rm -rf "$CC_TMP"
trap - EXIT

step "GATE 4d — populated customer-code upgrade"
CC_UPGRADE_SCRIPT="$(mktemp /tmp/operro-customer-code-upgrade.XXXXXX)"
trap 'rm -f "$CC_UPGRADE_SCRIPT"' EXIT
sed 's/\r$//' integration/customer_code_populated_upgrade.sh > "$CC_UPGRADE_SCRIPT"
chmod a+rx "$CC_UPGRADE_SCRIPT"
run_as_postgres env PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" PGPASSWORD="$PGPASSWORD" \
  bash "$CC_UPGRADE_SCRIPT" operro_customer_code_upgrade
rm -f "$CC_UPGRADE_SCRIPT"
trap - EXIT

step "GATE 5 — assembly RPC tests"
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20260721001350_test_assembly.sql

step "GATE 6 — package-reservation regression tests"
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20260721001350_test_reservation.sql

step "GATE 6b — payroll engine tests (sections 32-33)"
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261001100000_test_payroll_engine.sql

step "GATE 7 — real authenticated-role integration (incl reserve_package_session)"
psql_db operro_gate -q -v ON_ERROR_STOP=1 -c \
  "do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role operro_gate_client login noinherit; exception when duplicate_object then null; end \$\$; alter role operro_gate_client login noinherit password 'stagingpw'; grant anon to operro_gate_client; grant authenticated to operro_gate_client; grant usage on schema public, app to anon, authenticated;"
psql_db operro_gate -q -v ON_ERROR_STOP=1 -f integration/0100_integration_seed.sql
PGPASSWORD=stagingpw psql \
  "host=$PGHOST port=$PGPORT dbname=operro_gate user=operro_gate_client" \
  -v ON_ERROR_STOP=1 \
  -f integration/0100_integration_client.sql

step "GATE 7b — invoice pricing and package coverage parity"
psql_db operro_gate -v ON_ERROR_STOP=1 -f integration/invoice_parity_smoke.sql

step "GATE 7c — membership lifecycle and reconciliation"
psql_db operro_gate -v ON_ERROR_STOP=1 -f integration/package_lifecycle_smoke.sql

step "GATE 7d — retention and renewal follow-ups"
psql_db operro_gate -v ON_ERROR_STOP=1 -f integration/retention_renewal_followups_smoke.sql

step "GATE 7e — documents, payments, evidence, and visits"
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/S27-S30/test_backend.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261101100000_test_marketing_spend_roi.sql
psql_db operro_gate -v ON_ERROR_STOP=1 -f supabase/tests/20261101110000_test_cash_account_mappings.sql

step "GATE 7f — HomePaw intake, per-pet size pricing, and membership tiers"
bash integration/homepaw_qc_db.sh
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/homepaw_qc_smoke.sql
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/homepaw_size_membership_smoke.sql
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/homepaw_review_storage_smoke.sql

step "GATE 7g — dynamic size bands (SB-01..SB-04) behavior"
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/size_band_smoke.sql
bash integration/size_band_preflight.sh

step "GATE 7i — size-band management RPCs (SB-05): authority, layout, archive/delete, prices, RLS"
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/size_band_management_smoke.sql

step "GATE 7j — size-band management concurrency (two real sessions)"
bash integration/size_band_concurrency.sh

step "GATE 7k — size-band booking, package, invoice snapshot, and Customer 360 adapters"
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/size_band_adapters_smoke.sql

step "GATE 7l — authorized Customer 360 pet editing and snapshot immutability"
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/customer_pet_edit_smoke.sql

step "GATE 7m — dynamic size-band payroll (SB-06): tenant keys/labels, live re-banding, frozen runs, roles, tenants, anon"
psql_db operro_homepaw_qc -v ON_ERROR_STOP=1 -f integration/size_band_payroll_smoke.sql

step "GATE 7h — platform access, helper roles and dog-size boundaries (isolated database)"
bash integration/platform_access_qc.sh

step "GATE 8 — completion vs assembly/reservation concurrency"
run_as_postgres dropdb --if-exists operro_cc
run_as_postgres createdb operro_cc
psql_db operro_cc -q -v ON_ERROR_STOP=1 -c \
  "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create schema if not exists auth; create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb); create or replace function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid \$\$; create schema if not exists storage; create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table if not exists storage.objects(id uuid, bucket_id text, name text, metadata jsonb); create or replace function storage.foldername(name text) returns text[] language sql immutable as \$\$ select string_to_array(name, '/') \$\$; do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$; grant usage on schema auth to authenticated;"
psql_db operro_cc -q -v ON_ERROR_STOP=1 -f integration/gate_bootstrap_extensions.sql
for migration in "${EXPECTED_MIGRATIONS[@]}"; do
  psql_db operro_cc -q -v ON_ERROR_STOP=1 -f "$migration"
done
psql_db operro_cc -q -v ON_ERROR_STOP=1 -f supabase/tests/concurrency/conc_seed.sql
if [ -n "${GATE8_CONTAINER:-}" ]; then
  # WSL hosts without a native psql client can run the unchanged harness inside
  # the disposable PG16 container that has this repository mounted at /workspace.
  docker exec -w /workspace \
    -e DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@127.0.0.1:5432/operro_cc" \
    "$GATE8_CONTAINER" bash -lc '
      conc_tmp=$(mktemp -d /tmp/operro-concurrency.XXXXXX)
      trap '\''rm -rf "$conc_tmp"'\'' EXIT
      cp -a supabase/tests/concurrency/. "$conc_tmp/"
      sed -i '\''s/\r$//'\'' "$conc_tmp/run_concurrency_assembly.sh"
      bash "$conc_tmp/run_concurrency_assembly.sh"
    '
else
  CONC_TMP="$(mktemp -d /tmp/operro-concurrency.XXXXXX)"
  trap 'rm -rf "$CONC_TMP"' EXIT
  cp -a supabase/tests/concurrency/. "$CONC_TMP/"
  # Windows checkouts may materialize shell scripts with CRLF.
  sed -i 's/\r$//' "$CONC_TMP/run_concurrency_assembly.sh"
  chmod -R a+rX "$CONC_TMP"
  run_as_postgres env DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/operro_cc" \
    bash "$CONC_TMP/run_concurrency_assembly.sh"
  rm -rf "$CONC_TMP"
  trap - EXIT
fi

step "GATE 8b — storage cleanup: two real sessions racing for one organization"
SC_TMP="$(mktemp -d /tmp/operro-storage-cleanup-gate.XXXXXX)"
trap 'rm -rf "$SC_TMP"' EXIT
cp -a supabase/tests/storage_cleanup/. "$SC_TMP/"
find "$SC_TMP" -type f -exec sed -i 's/\r$//' {} +
chmod -R a+rX "$SC_TMP"
run_as_postgres env DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/operro_cc" \
  bash "$SC_TMP/run_storage_cleanup_concurrency.sh"
rm -rf "$SC_TMP"
trap - EXIT

echo ""
echo "ALL GATES PASSED"
