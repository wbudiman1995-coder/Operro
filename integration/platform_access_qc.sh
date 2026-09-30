#!/usr/bin/env bash
# Isolated PG16 proof for platform provisioning, invitations, permissions and sizes.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGUSER=postgres
dropdb --if-exists operro_platform_qc
createdb operro_platform_qc
psql operro_platform_qc -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
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
psql operro_platform_qc -v ON_ERROR_STOP=1 -q -f integration/gate_bootstrap_extensions.sql
for migration in supabase/migrations/*.sql; do
  if [[ "$migration" == *20261019100000_platform_org_access.sql ]]; then
    # Rehearse the real upgrade: the Operro owner already exists, but the flag
    # is false before this migration runs.
    psql operro_platform_qc -v ON_ERROR_STOP=1 -q -c "insert into auth.users(id,email,email_confirmed_at) values ('a1000000-0000-4000-8000-000000000001','wbudiman1995@gmail.com',now())"
  fi
  psql operro_platform_qc -v ON_ERROR_STOP=1 -q -f "$migration"
done
psql operro_platform_qc -v ON_ERROR_STOP=1 -f integration/platform_access_smoke.sql
