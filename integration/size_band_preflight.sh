#!/usr/bin/env bash
# U-05: SB-04 must refuse to run (naming organization and row) when a stored pet
# size or package band is not a size band of its own organization, must leave
# nothing applied, and must succeed on the same data once it is corrected.
# Run against a disposable PostgreSQL 16 server from any checkout location.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGUSER=postgres
db=operro_sb_preflight
fail() { echo "FAIL: $*" >&2; exit 1; }

dropdb --if-exists "$db"
createdb "$db"
psql "$db" -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
create schema if not exists storage;
create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects(id uuid, bucket_id text, name text, metadata jsonb);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
grant usage on schema auth to authenticated;
SQL
psql "$db" -v ON_ERROR_STOP=1 -q -f integration/gate_bootstrap_extensions.sql
for migration in supabase/migrations/*.sql; do
  case "$migration" in *_size_band_integrity.sql) break;; esac
  psql "$db" -v ON_ERROR_STOP=1 -q -f "$migration"
done

# A database whose CHECKs were not enforced (e.g. NOT VALID) can hold off-list values.
psql "$db" -v ON_ERROR_STOP=1 -q <<'SQL'
alter table public.pets drop constraint chk_pets_size;
alter table public.packages drop constraint chk_packages_size_band;
insert into public.organizations(id,name,slug,status) values ('5d000000-0000-4000-8000-000000000001','Preflight','preflight','active');
insert into public.customers(id,organization_id,display_name,status) values ('5d000000-0000-4000-8000-0000000000c1','5d000000-0000-4000-8000-000000000001','C','active');
insert into public.pets(id,organization_id,customer_id,name,species,size,status)
values ('5d000000-0000-4000-8000-0000000000f1','5d000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-0000000000c1','Giant','dog','giant','active');
insert into public.service_catalog(id,organization_id,name,base_price) values ('5d000000-0000-4000-8000-0000000000e1','5d000000-0000-4000-8000-000000000001','S',1);
insert into public.packages(id,organization_id,name,service_id,total_sessions,price,per_pet,size_band)
values ('5d000000-0000-4000-8000-0000000000d1','5d000000-0000-4000-8000-000000000001','Huge tier','5d000000-0000-4000-8000-0000000000e1',1,1,true,'huge');
SQL

set +e
out=$(psql "$db" -v ON_ERROR_STOP=1 -q -f supabase/migrations/20261023130000_size_band_integrity.sql 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "SB-04 applied despite off-list pet size / package band"
echo "$out" | grep -q 'size_band_preflight_failed' || fail "missing preflight error: $out"
echo "$out" | grep -q '5d000000-0000-4000-8000-000000000001:5d000000-0000-4000-8000-0000000000f1:giant' || fail "preflight did not name the offending pet: $out"
echo "$out" | grep -q '5d000000-0000-4000-8000-000000000001:5d000000-0000-4000-8000-0000000000d1:huge' || fail "preflight did not name the offending package: $out"

# Nothing may have been applied (single transaction).
[ "$(psql "$db" -Atc "select count(*) from pg_constraint where conname in ('fk_pets_size_band','fk_packages_size_band')")" = 0 ] || fail "foreign keys leaked from a refused migration"
[ "$(psql "$db" -Atc "select to_regprocedure('app.tg_pets_size_band_guard()') is null")" = t ] || fail "guard function leaked from a refused migration"
[ "$(psql "$db" -Atc "select count(*) from pg_trigger where tgname in ('trg_pets_size_band_guard','trg_packages_size_band_guard')")" = 0 ] || fail "guard triggers leaked"
[ "$(psql "$db" -Atc "select pg_get_functiondef('app.create_customer_household(text,text,jsonb,jsonb)'::regprocedure) like '%organization_size_bands%'")" = f ] || fail "household function was redefined by a refused migration"
[ "$(psql "$db" -Atc "select size from public.pets where id='5d000000-0000-4000-8000-0000000000f1'")" = giant ] || fail "existing values were rewritten"
echo "PASS U-05 SB-04 refused off-list values, named organization/pet/package, applied nothing"

# Correct the data (an operator decision, never done by the migration) and the same file applies.
psql "$db" -v ON_ERROR_STOP=1 -q -c "update public.pets set size=null where id='5d000000-0000-4000-8000-0000000000f1'" \
  -c "delete from public.packages where id='5d000000-0000-4000-8000-0000000000d1'"   -c "alter table public.pets add constraint chk_pets_size check (size is null or size in ('extra_small','small','medium','large','extra_large'))"   -c "alter table public.packages add constraint chk_packages_size_band check (size_band is null or size_band in ('extra_small','small','medium','large','extra_large','cat'))"
psql "$db" -v ON_ERROR_STOP=1 -q -f supabase/migrations/20261023130000_size_band_integrity.sql
[ "$(psql "$db" -Atc "select bool_and(convalidated) from pg_constraint where conname in ('fk_pets_size_band','fk_packages_size_band')")" = t ] || fail "foreign keys not validated after correction"
echo "PASS U-05b SB-04 applies once the offending rows are corrected"
