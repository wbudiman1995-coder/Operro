#!/usr/bin/env bash
# Rehearse the shared Supabase project's 20260924110000 -> combined-head upgrade
# against a disposable PostgreSQL 16 database containing HomePaw demo records.
# The remote history also skipped 20260919120000; apply it after the baseline,
# exactly as Supabase CLI's --include-all plan does.
# Does not connect to or modify any Supabase project.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d /tmp/operro-upgrade.XXXXXX)
container="operro_upgrade_pg16_$$"
cutoff=20260924110000
log="$repo/docs/handoffs/logs/INTEGRATION/populated-upgrade.log"
mkdir -p "$(dirname "$log")"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

tar -C "$repo" --exclude=.git --exclude=node_modules --exclude=.next \
  --exclude=.env.local --exclude=docs/handoffs/logs/INTEGRATION -cf - . | tar -xf - -C "$scratch"
find "$scratch" -type f -name '*.sh' -exec sed -i 's/\r$//' {} +
docker run -d --name "$container" -e POSTGRES_PASSWORD=postgres \
  -v "$scratch:/work" postgres:16 >/dev/null
for i in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null
sql() {
  docker exec -i -w /work "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@" || {
    result=$?
    echo "SQL command failed with exit $result" >&2
    exit "$result"
  }
}

{
  echo "PostgreSQL: $(docker exec "$container" psql -U postgres -Atc 'show server_version')"
  echo "Baseline migration: $cutoff"
  sql <<'SQL'
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create schema if not exists storage;
create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects(id uuid, bucket_id text, name text);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
SQL
  sql -f integration/gate_bootstrap_extensions.sql
  baseline_count=0
  for migration in "$scratch"/supabase/migrations/*.sql; do
    version=$(basename "$migration")
    version=${version%%_*}
    if [[ "$version" > "$cutoff" || "$version" == "20260919120000" ]]; then continue; fi
    echo "BASELINE $version"
    sql -q -f "/work/supabase/migrations/$(basename "$migration")"
    baseline_count=$((baseline_count + 1))
  done
  echo "Baseline migrations applied: $baseline_count"

  sql <<'SQL'
insert into auth.users(id,email,raw_user_meta_data)
values ('e0000000-0000-4000-8000-000000000001','wbudiman1995@gmail.com','{}');
insert into public.users(id,full_name,email,status)
values ('e0000000-0000-4000-8000-000000000001','HomePaw Owner','wbudiman1995@gmail.com','active')
on conflict (id) do update set full_name=excluded.full_name,email=excluded.email,status=excluded.status;
SQL
  sql -f supabase/seeds/homepaw_demo.sql
  sql <<'SQL'
-- The real HomePaw org was created without owner grants or entitlements.
-- Reproduce that exact identity tuple and empty configuration before upgrade.
insert into auth.users(id,email,raw_user_meta_data)
values ('047f1e5c-5935-4566-b793-417df9f7cc9c','homepaw-owner@local.test','{}');
insert into public.users(id,full_name,email,status)
values ('047f1e5c-5935-4566-b793-417df9f7cc9c','HomePaw Owner','homepaw-owner@local.test','active')
on conflict (id) do update set full_name=excluded.full_name,email=excluded.email,status=excluded.status;
insert into public.organizations(id,name,slug,status,vertical)
values ('019fbdd0-ee52-7f57-8318-a288203c78c1','HomePaw','homepaw','active','grooming');
insert into public.roles(id,organization_id,name,is_system)
values ('019fbdd0-ee64-7327-97e4-fe23f30dbff1','019fbdd0-ee52-7f57-8318-a288203c78c1','Owner',true);
insert into public.memberships(id,user_id,organization_id,role_id,status)
values ('019fbdd0-ee6c-7f31-861b-7a981bc599be','047f1e5c-5935-4566-b793-417df9f7cc9c',
        '019fbdd0-ee52-7f57-8318-a288203c78c1','019fbdd0-ee64-7327-97e4-fe23f30dbff1','active');
SQL
  before=$(docker exec "$container" psql -U postgres -Atc \
    "select (select count(*) from public.organizations)||','||(select count(*) from public.customers)||','||(select count(*) from public.pets)||','||(select count(*) from public.bookings)")
  echo "Populated baseline counts org,customer,pet,booking: $before"

  upgrade_count=0
  for migration in "$scratch"/supabase/migrations/*.sql; do
    version=$(basename "$migration")
    version=${version%%_*}
    if [[ "$version" != "20260919120000" && ( "$version" < "$cutoff" || "$version" == "$cutoff" ) ]]; then continue; fi
    # The dynamic size-band migrations are rehearsed separately below, on top
    # of the extra populated fixture, with before/after row fingerprints.
    case "$(basename "$migration")" in *_size_band_*) continue;; esac
    echo "UPGRADE $version"
    sql -q -f "/work/supabase/migrations/$(basename "$migration")"
    upgrade_count=$((upgrade_count + 1))
  done
  echo "Upgrade migrations applied: $upgrade_count"
  after=$(docker exec "$container" psql -U postgres -Atc \
    "select (select count(*) from public.organizations)||','||(select count(*) from public.customers)||','||(select count(*) from public.pets)||','||(select count(*) from public.bookings)")
  echo "After upgrade counts org,customer,pet,booking: $after"
  [[ "$before" == "$after" ]] || { echo "FAIL: demo records changed in count"; exit 1; }
  sql <<'SQL'
do $$
declare v_org uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
        v_role uuid := '019fbdd0-ee64-7327-97e4-fe23f30dbff1';
begin
  if (select count(*) from public.role_permissions where organization_id=v_org and role_id=v_role)
     <> (select count(*) from public.permissions where deleted_at is null) then
    raise exception 'HomePaw owner grants incomplete';
  end if;
  if (select count(*) from public.subscriptions where organization_id=v_org and status='active' and deleted_at is null) <> 1
    or (select count(*) from public.organization_modules where organization_id=v_org and enabled)
       <> (select count(*) from public.modules where is_active and deleted_at is null)
    or (select count(*) from public.branches where organization_id=v_org and is_default and deleted_at is null) <> 1
  then raise exception 'HomePaw workspace provision incomplete'; end if;
end $$;
SQL
  echo "HOMEPAW OWNER WORKSPACE PROVISION PASS"

  # ---- Dynamic size bands (foundation, management, and Bundle 3 adapters) ----
  sql -f integration/size_band_upgrade_fixture.sql
  # Payroll export detail rows as the PRE-SB-06 function returns them (old columns only), to prove the
  # migrated function still returns exactly the same data for the same period.
  export_cols="booking_id,membership_id,starts_at,customer_name,pet_name,pet_size,services,service_revenue,invoice_number,invoice_id,invoice_status"
  export_probe="select count(*)||'|'||coalesce(md5(string_agg(concat_ws('~',$export_cols), '|' order by booking_id, membership_id, pet_name)),'-') from app.payroll_export_detail_rows('5c000000-0000-4000-8000-000000000001', current_date-30, current_date-1)"
  export_before=$(sql -Atc "$export_probe")
  [[ "${export_before%%|*}" != 0 ]] || { echo "FAIL: upgrade fixture has no payroll export rows"; exit 1; }
  echo "Pre-SB-06 payroll export detail rows|hash: $export_before"
  fp_before=$(sql -q -f integration/size_band_upgrade_fingerprint.sql)
  echo "Pre-size-band fingerprint lines: $(printf '%s
' "$fp_before" | wc -l)"
  size_band_count=0
  for migration in "$scratch"/supabase/migrations/*_size_band_*.sql; do
    echo "SIZE-BAND $(basename "$migration")"
    sql -q -f "/work/supabase/migrations/$(basename "$migration")"
    size_band_count=$((size_band_count + 1))
  done
  [[ "$size_band_count" == "7" ]] || { echo "FAIL: expected 7 size-band migrations through Bundle 4, found $size_band_count"; exit 1; }
  [[ "$(sql -Atc "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname in ('preview_size_layout_impact','save_size_bands','archive_size_band','delete_size_band','set_service_band_prices','set_size_band_mode')")" == "6" ]]     || { echo "FAIL: SB-05 management RPCs missing after upgrade"; exit 1; }
  [[ "$(sql -Atc "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname in ('resolve_pet_pricing_keys','preview_booking_resolution')")" == "2" ]] || { echo "FAIL: Bundle 3 adapter RPCs missing after upgrade"; exit 1; }
  fp_after=$(sql -q -f integration/size_band_upgrade_fingerprint.sql)
  if [[ "$fp_before" != "$fp_after" ]]; then
    echo "FAIL: size-band migrations changed existing data"
    diff <(printf '%s
' "$fp_before") <(printf '%s
' "$fp_after") || true
    exit 1
  fi
  printf '%s
' "$fp_after"
  echo "SIZE BAND DATA PRESERVATION PASS (counts and row hashes of pets, snapshots, packages, entitlements, prices, durations, invoices, payroll unchanged)"
  sql -f integration/size_band_upgrade_checks.sql
  # the migrated export RPC authorizes the caller, so probe it as the fixture owner inside a rolled-back transaction
  export_after=$(sql -q -At <<SQL | tail -1
begin;
insert into public.role_permissions(organization_id,role_id,permission_id)
  select '5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000a2',p.id from public.permissions p where p.key='payroll.read' on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
  select '5c000000-0000-4000-8000-000000000001',m.id,true from public.modules m where m.key='payroll' on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions(organization_id,status) values ('5c000000-0000-4000-8000-000000000001','active') on conflict do nothing;
select set_config('request.jwt.claims','{"sub":"5c000000-0000-4000-8000-0000000000a1","active_org_id":"5c000000-0000-4000-8000-000000000001"}',true) \gset
$export_probe;
rollback;
SQL
)
  [[ "$export_before" == "$export_after" ]] || { echo "FAIL: payroll export detail rows changed across SB-06 ($export_before vs $export_after)"; exit 1; }
  echo "PAYROLL EXPORT PRESERVATION PASS (rows|hash $export_after identical before and after SB-06)"
  # U-06: the backfill steps are idempotent (re-run the data statements verbatim)
  fp_mid=$(sql -q -f integration/size_band_upgrade_fingerprint.sql)
  bands_before=$(sql -Atc "select count(*) from public.organization_size_bands")
  prices_before=$(sql -Atc "select count(*) from public.service_band_prices")
  settings_before=$(sql -Atc "select count(*) from public.organization_size_band_settings")
  sed -n '/^-- Backfill every existing organization/,/^commit;/p' "$scratch"/supabase/migrations/20261023100000_size_band_tables.sql | sed '$d' | sql -q
  sed -n '/^-- Backfill: one row per legacy/,/^commit;/p' "$scratch"/supabase/migrations/20261023110000_size_band_shadow_sync.sql | sed '$d' | sql -q
  [[ "$bands_before" == "$(sql -Atc "select count(*) from public.organization_size_bands")"      && "$prices_before" == "$(sql -Atc "select count(*) from public.service_band_prices")"      && "$settings_before" == "$(sql -Atc "select count(*) from public.organization_size_band_settings")" ]]     || { echo "FAIL: backfill re-run changed row counts"; exit 1; }
  [[ "$fp_mid" == "$(sql -q -f integration/size_band_upgrade_fingerprint.sql)" ]] || { echo "FAIL: backfill re-run changed existing data"; exit 1; }
  echo "SIZE BAND BACKFILL IDEMPOTENCY PASS (bands=$bands_before settings=$settings_before prices=$prices_before)"
  # Organization export on the populated, upgraded HomePaw workspace: the owner can page every allowlisted
  # table to completion and each table's exported row count equals that organization's own row count.
  sql -q <<'SQL'
begin;
select set_config('request.jwt.claims','{"sub":"047f1e5c-5935-4566-b793-417df9f7cc9c","active_org_id":"019fbdd0-ee52-7f57-8318-a288203c78c1"}',true);
do $$
declare
  v_org constant uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
  v_job uuid; v_work jsonb; v_rows jsonb; v_count integer; v_steps integer := 0; v_src bigint; v_got bigint; v_all bigint := 0; r record;
begin
  create temp table exp_counts(t text, n bigint) on commit drop;
  v_job := (app.org_export_start(true) ->> 'job_id')::uuid;
  loop
    v_work := app.org_export_next_work(v_job);
    exit when (v_work ->> 'done')::boolean;
    v_steps := v_steps + 1; if v_steps > 5000 then raise exception 'FAIL export did not terminate'; end if;
    v_rows := app.org_export_table_page(v_job, v_work ->> 'table_name', nullif(v_work ->> 'after_id','')::uuid, 200);
    v_count := jsonb_array_length(v_rows);
    if v_count = 0 then
      perform app.org_export_finish_table(v_job, v_work ->> 'table_name', nullif(v_work ->> 'after_id','')::uuid);
    else
      perform app.org_export_record_chunk(v_job, v_work ->> 'table_name', (v_work ->> 'chunk_index')::int, v_count, repeat('c', 64),
        (v_rows -> 0 ->> 'id')::uuid, (v_rows -> (v_count - 1) ->> 'id')::uuid,
        (v_work ->> 'storage_prefix') || '/tables/' || (v_work ->> 'table_name') || '/chunk-' || lpad(v_work ->> 'chunk_index', 5, '0') || '.jsonl');
      insert into exp_counts values (v_work ->> 'table_name', v_count);
    end if;
  end loop;
  for r in select table_name from app.organization_export_table_specs loop
    execute format('select count(*) from public.%I where organization_id = $1', r.table_name) into v_src using v_org;
    select coalesce(sum(n), 0) into v_got from exp_counts where t = r.table_name;
    if v_src <> v_got then raise exception 'FAIL export of % returned % rows, organization owns %', r.table_name, v_got, v_src; end if;
    v_all := v_all + v_got;
  end loop;
  if v_all = 0 then raise exception 'FAIL populated export exported no rows'; end if;
  if app.org_export_configuration() ->> 'id' <> v_org::text then raise exception 'FAIL export configuration organization'; end if;
  raise notice 'ORGANIZATION EXPORT POPULATED PASS (% rows across % allowlisted tables, every count equals the organization''s own)', v_all, (select count(*) from app.organization_export_table_specs);
end $$;
rollback;
SQL
  # Remaining-nine migrations (custom fields ... health/recovery) on the populated, upgraded HomePaw workspace.
  probe_out=$(sql -q -f integration/remaining_nine_upgrade_probe.sql 2>&1) || { echo "$probe_out"; echo "FAIL: remaining-nine populated probe"; exit 1; }
  printf '%s\n' "$probe_out"
  grep -q 'REMAINING NINE POPULATED PROBE PASS' <<<"$probe_out" || { echo "FAIL: remaining-nine populated probe did not reach its pass marker"; exit 1; }
  # Performance dashboard migration on the same populated workspace.
  perf_out=$(sql -q -f integration/performance_dashboard_upgrade_probe.sql 2>&1) || { echo "$perf_out"; echo "FAIL: performance dashboard populated probe"; exit 1; }
  printf '%s\n' "$perf_out"
  grep -q 'PERFORMANCE DASHBOARD POPULATED PROBE PASS' <<<"$perf_out" || { echo "FAIL: performance dashboard populated probe did not reach its pass marker"; exit 1; }
  # Final parity closeout migrations (alerts, cash register, WhatsApp batches, export scope, hours, consent, health).
  closeout_out=$(sql -q -f integration/final_closeout_upgrade_probe.sql 2>&1) || { echo "$closeout_out"; echo "FAIL: final closeout populated probe"; exit 1; }
  printf '%s\n' "$closeout_out"
  grep -q 'FINAL CLOSEOUT POPULATED PROBE PASS' <<<"$closeout_out" || { echo "FAIL: final closeout populated probe did not reach its pass marker"; exit 1; }
  # Final parity operations migrations (spend and return, cash mappings, provider boundary, defaults, readiness, drill evidence).
  ops_out=$(sql -q -f integration/final_operations_upgrade_probe.sql 2>&1) || { echo "$ops_out"; echo "FAIL: final operations populated probe"; exit 1; }
  printf '%s
' "$ops_out"
  grep -q 'FINAL OPERATIONS POPULATED PROBE PASS' <<<"$ops_out" || { echo "FAIL: final operations populated probe did not reach its pass marker"; exit 1; }
  sql -Atc "select to_regprocedure('app.list_audit_events(text,uuid,integer)') is not null as audit_rpc, to_regprocedure('app.record_payment(uuid,text,numeric,text,uuid,uuid)') is not null as payment_rpc"
  echo "POPULATED UPGRADE PASS"
} >"$log" 2>&1 || { tail -70 "$log"; exit 1; }

tail -20 "$log"
