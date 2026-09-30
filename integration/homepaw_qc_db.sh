#!/usr/bin/env bash
# Run against a disposable PostgreSQL 16 database from any checkout location.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGUSER=postgres
dropdb --if-exists operro_homepaw_qc
createdb operro_homepaw_qc
psql operro_homepaw_qc -v ON_ERROR_STOP=1 -q <<'SQL'
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
psql operro_homepaw_qc -v ON_ERROR_STOP=1 -q -f integration/gate_bootstrap_extensions.sql
for migration in supabase/migrations/*.sql; do
  echo "apply $(basename "$migration")"
  psql operro_homepaw_qc -v ON_ERROR_STOP=1 -q -f "$migration"
done
echo 'all migrations applied'
