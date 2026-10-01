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
expected_head=20261023110000
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
    "select (select count(*) from public.organizations)||','||(select count(*) from public.customers)||','||(select count(*) from public.pets)||','||(select count(*) from public.bookings)||','||(select count(*) from public.packages)||','||(select count(*) from public.customer_packages)||','||(select count(*) from public.invoice_lines)")
  echo "Populated baseline counts org,customer,pet,booking,package,customer_package,invoice_line: $before"

  upgrade_count=0
  last_upgrade=''
  for migration in "$scratch"/supabase/migrations/*.sql; do
    version=$(basename "$migration")
    version=${version%%_*}
    if [[ "$version" != "20260919120000" && ( "$version" < "$cutoff" || "$version" == "$cutoff" ) ]]; then continue; fi
    echo "UPGRADE $version"
    sql -q -f "/work/supabase/migrations/$(basename "$migration")"
    upgrade_count=$((upgrade_count + 1))
    last_upgrade=$version
  done
  echo "Upgrade migrations applied: $upgrade_count"
  [[ "$last_upgrade" == "$expected_head" ]] || { echo "FAIL: rehearsal stopped at $last_upgrade, expected $expected_head"; exit 1; }
  after=$(docker exec "$container" psql -U postgres -Atc \
    "select (select count(*) from public.organizations)||','||(select count(*) from public.customers)||','||(select count(*) from public.pets)||','||(select count(*) from public.bookings)||','||(select count(*) from public.packages)||','||(select count(*) from public.customer_packages)||','||(select count(*) from public.invoice_lines)")
  echo "After upgrade counts org,customer,pet,booking,package,customer_package,invoice_line: $after"
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
  sql -Atc "select to_regprocedure('app.list_audit_events(text,uuid,integer)') is not null as audit_rpc, to_regprocedure('app.record_payment(uuid,text,numeric,text,uuid,uuid)') is not null as payment_rpc"
  echo "POPULATED UPGRADE PASS"
} >"$log" 2>&1 || { tail -70 "$log"; exit 1; }

tail -20 "$log"
