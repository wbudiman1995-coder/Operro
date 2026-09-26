#!/usr/bin/env bash
# Regression test for Codex review finding #1 (branch 86ad714):
# 20260926090000_membership_renewal_billing_and_reconciliation.sql must
# succeed when applied to a database that already has REAL purchase ledger
# rows ("upgrading a populated database"), not just a fresh, empty schema.
#
# The bug this guards against: the migration originally included an UPDATE
# against public.customer_package_ledger to backfill invoice_id onto
# existing 'purchase' rows. customer_package_ledger is append-only
# (trg_cpl_block_update, added in 20260721000700_customer_programs.sql,
# unconditionally raises restrict_violation on any UPDATE). On a FRESH,
# empty schema that UPDATE matches zero rows and the trigger body never
# runs, so the migration silently "passes" -- but the moment a real
# customer_package_ledger 'purchase' row already exists (any actual
# installation that has sold even one package), the same migration would
# raise restrict_violation and fail outright. The fix removed the backfill
# UPDATE entirely (see the invoice_id column comment in the migration
# itself); this script proves the fix by reproducing the exact scenario the
# bug needed: apply everything BEFORE this migration, create a REAL
# purchase, THEN apply this migration on top.
#
# Strengthened (review round 3): a row count staying the same does not
# prove a row is untouched. This script hashes the pre-existing purchase
# ledger row's full content (and the corresponding customer_packages
# balance/source association) BEFORE the upgrade and again AFTER, and fails
# unless they are byte-identical; it also confirms the row's new invoice_id
# column is left NULL (never backfilled) and that append-only enforcement
# on customer_package_ledger is still active after the upgrade (an UPDATE
# attempt must still fail).
#
# Run from the repository root against a disposable database:
#   PGHOST=... PGPORT=... PGUSER=... PGPASSWORD=... bash integration/migration_upgrade_replay.sh [database_name]
# In this sandbox (WSL2 host->container TCP is unreachable), run it via
# docker exec inside the same disposable postgres:16 container used for the
# other gates -- see docs/handoffs/S23-S26-HANDOFF.md for the exact commands.
set -euo pipefail
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB="${1:-operro_upgrade_replay}"
MIGRATION_UNDER_TEST="supabase/migrations/20260926090000_membership_renewal_billing_and_reconciliation.sql"

step() { echo ""; echo "########## $* ##########"; }

if [ ! -f "$MIGRATION_UNDER_TEST" ]; then
  echo "Run this script from the repository root (expected to find $MIGRATION_UNDER_TEST)." >&2
  exit 1
fi

mapfile -t PRIOR_MIGRATIONS < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' ! -name "$(basename "$MIGRATION_UNDER_TEST")" -print | sort)

step "fresh database: $DB"
dropdb --if-exists "$DB"
createdb "$DB"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -c "
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create schema if not exists storage;
create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects(id uuid, bucket_id text, name text);
create or replace function storage.foldername(name text) returns text[] language sql immutable as \$body\$ select string_to_array(name, '/') \$body\$;
do \$body\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$body\$;
do \$body\$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end \$body\$;
do \$body\$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end \$body\$;
do \$body\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$body\$;
"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f integration/gate_bootstrap_extensions.sql

step "applying ${#PRIOR_MIGRATIONS[@]} prior migrations (the state a real installation would be in before this upgrade)"
for m in "${PRIOR_MIGRATIONS[@]}"; do
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$m"
done

step "seeding a REAL purchase (a real customer_package_ledger 'purchase' row, via the real app.create_package_invoice RPC) BEFORE upgrading"
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
begin;
insert into public.organizations (id, name, slug, status) values ('09000000-0000-4000-8000-000000000001','Upgrade Org','upgrade-org','active');
insert into public.branches (id, organization_id, name, is_default, status) values ('09000000-0000-4000-8000-0000000000a1','09000000-0000-4000-8000-000000000001','Main',true,'active');
insert into auth.users (id) values ('09000000-0000-4000-8000-0000000000c1') on conflict (id) do nothing;
insert into public.users (id, full_name, email, status) values ('09000000-0000-4000-8000-0000000000c1','Owner','owner@upgrade.test','active') on conflict (id) do update set full_name = excluded.full_name;
insert into public.roles (id, organization_id, name, is_system) values ('09000000-0000-4000-8000-0000000000e1','09000000-0000-4000-8000-000000000001','Owner',true);
insert into public.memberships (id, organization_id, user_id, role_id, status) values ('09000000-0000-4000-8000-0000000000d1','09000000-0000-4000-8000-000000000001','09000000-0000-4000-8000-0000000000c1','09000000-0000-4000-8000-0000000000e1','active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values ('09000000-0000-4000-8000-000000000001','09000000-0000-4000-8000-0000000000d1','09000000-0000-4000-8000-0000000000a1');
insert into public.permissions (id, key, resource, action, description) values ('09000000-0000-4000-8000-0000000000f1','membership.manage','membership','manage','m'),('09000000-0000-4000-8000-0000000000f2','invoice.issue','invoice','issue','i') on conflict (key) do nothing;
insert into public.role_permissions (organization_id, role_id, permission_id) select '09000000-0000-4000-8000-000000000001','09000000-0000-4000-8000-0000000000e1',id from public.permissions where key in ('membership.manage','invoice.issue');
insert into public.organization_modules (organization_id, module_id, enabled) select '09000000-0000-4000-8000-000000000001', id, true from public.modules where key in ('finance','membership') on conflict (organization_id, module_id) do update set enabled = true;
insert into public.subscriptions (organization_id, status) values ('09000000-0000-4000-8000-000000000001','active') on conflict do nothing;
insert into public.customers (id, organization_id, display_name) values ('09000000-0000-4000-8000-00000000c101','09000000-0000-4000-8000-000000000001','Real Customer');
insert into public.packages (id, organization_id, name, total_sessions, price, currency) values ('09000000-0000-4000-8000-00000000ca01','09000000-0000-4000-8000-000000000001','Real Package',3,300000,'IDR');
select set_config('request.jwt.claims', json_build_object('sub','09000000-0000-4000-8000-0000000000c1','active_org_id','09000000-0000-4000-8000-000000000001')::text, true);
select app.create_package_invoice('09000000-0000-4000-8000-0000000000a1','09000000-0000-4000-8000-00000000c101','09000000-0000-4000-8000-00000000ca01', now(), null, null, '09000000-0000-4000-8000-0000000000f9');
commit;
SQL
REAL_PURCHASE_ROWS=$(psql -d "$DB" -tAc "select count(*) from public.customer_package_ledger where reason='purchase';")
echo "real purchase ledger rows before upgrade: $REAL_PURCHASE_ROWS"
[ "$REAL_PURCHASE_ROWS" -ge 1 ] || { echo "FAIL: fixture did not create a real purchase ledger row"; exit 1; }

step "capturing pre-upgrade content hashes (row count alone does not prove 'untouched' -- review round 3)"
# A content hash of every column that legitimately exists BEFORE this
# migration (invoice_id is deliberately excluded -- it does not exist yet).
# md5(string_agg(...)) over the deterministic id order is stable across the
# two runs as long as no row's actual content changed.
PRE_LEDGER_HASH=$(psql -d "$DB" -tAc "select md5(string_agg(id::text || ':' || customer_package_id::text || ':' || delta::text || ':' || reason || ':' || coalesce(notes,'') || ':' || occurred_at::text || ':' || created_at::text, '|' order by id)) from public.customer_package_ledger where reason = 'purchase';")
PRE_CP_HASH=$(psql -d "$DB" -tAc "select md5(string_agg(id::text || ':' || sessions_remaining::text || ':' || coalesce(source_invoice_id::text,'-') || ':' || revision::text || ':' || status, '|' order by id)) from public.customer_packages;")
echo "pre-upgrade ledger content hash: $PRE_LEDGER_HASH"
echo "pre-upgrade customer_packages content hash: $PRE_CP_HASH"

step "applying the migration under test on top of REAL DATA -- the actual regression check"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$MIGRATION_UNDER_TEST"

step "verifying the real purchase row's PRE-EXISTING columns are byte-identical after the upgrade (not merely 'still exists'), invoice_id was NOT backfilled onto it, and append-only enforcement still holds"
POST_LEDGER_HASH=$(psql -d "$DB" -tAc "select md5(string_agg(id::text || ':' || customer_package_id::text || ':' || delta::text || ':' || reason || ':' || coalesce(notes,'') || ':' || occurred_at::text || ':' || created_at::text, '|' order by id)) from public.customer_package_ledger where reason = 'purchase';")
POST_CP_HASH=$(psql -d "$DB" -tAc "select md5(string_agg(id::text || ':' || sessions_remaining::text || ':' || coalesce(source_invoice_id::text,'-') || ':' || revision::text || ':' || status, '|' order by id)) from public.customer_packages;")
echo "post-upgrade ledger content hash: $POST_LEDGER_HASH"
echo "post-upgrade customer_packages content hash: $POST_CP_HASH"
[ "$PRE_LEDGER_HASH" = "$POST_LEDGER_HASH" ] || { echo "FAIL: pre-existing ledger row content changed across the upgrade (it must be byte-identical -- the ledger is append-only)"; exit 1; }
[ "$PRE_CP_HASH" = "$POST_CP_HASH" ] || { echo "FAIL: pre-existing customer_packages content changed across the upgrade (balance/source association must be untouched)"; exit 1; }

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
do $$
declare v_count int; v_has_column boolean; v_invoice_id_after uuid;
begin
  select count(*) into v_count from public.customer_package_ledger where reason = 'purchase';
  if v_count < 1 then raise exception 'FAIL: purchase ledger row disappeared after upgrade'; end if;
  select exists(select 1 from information_schema.columns where table_schema='public' and table_name='customer_package_ledger' and column_name='invoice_id') into v_has_column;
  if not v_has_column then raise exception 'FAIL: invoice_id column missing after upgrade'; end if;
  -- The whole point of removing the backfill UPDATE: this pre-existing
  -- purchase row's new invoice_id column must be NULL, not retroactively
  -- populated (that would have required the very UPDATE that was removed).
  select invoice_id into v_invoice_id_after from public.customer_package_ledger where reason = 'purchase' limit 1;
  if v_invoice_id_after is not null then raise exception 'FAIL: invoice_id was backfilled onto a pre-existing row -- this should be structurally impossible without an UPDATE, which was removed'; end if;
  raise notice 'UPGRADE_REPLAY_OK: % pre-existing purchase row(s) byte-identical, invoice_id column present and correctly left NULL (not backfilled)', v_count;
end $$;
SQL

step "verifying append-only enforcement itself still holds after the upgrade (the migration must not have weakened it)"
set +e
psql -d "$DB" -v ON_ERROR_STOP=1 -tAc "update public.customer_package_ledger set notes = 'tampered' where reason = 'purchase';" 2>/tmp_upgrade_replay_block_check.log
BLOCK_RC=$?
set -e
if [ "$BLOCK_RC" -eq 0 ]; then
  echo "FAIL: an UPDATE against customer_package_ledger succeeded after the upgrade -- append-only enforcement was weakened"
  exit 1
fi
grep -qi "append-only\|immutable\|restrict_violation" /tmp_upgrade_replay_block_check.log || { echo "FAIL: the UPDATE failed for an unexpected reason (not the append-only trigger)"; cat /tmp_upgrade_replay_block_check.log; exit 1; }
echo "append-only enforcement confirmed still active post-upgrade: $(cat /tmp_upgrade_replay_block_check.log | tr '\n' ' ')"
rm -f /tmp_upgrade_replay_block_check.log

echo ""
echo "MIGRATION UPGRADE REPLAY PASSED (populated-database upgrade succeeded; pre-existing rows proven byte-identical, not merely present; append-only behavior preserved)"
