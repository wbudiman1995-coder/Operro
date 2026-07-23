-- =====================================================================
-- Migration        20260721000150_fix_uuidv7_supabase
-- Purpose          Supabase compatibility for the UUIDv7 generator.
--
-- On Supabase, pgcrypto is installed into the `extensions` schema, NOT into
-- `public`/`app`. The generator defined in 20260721000100 is
-- `app.uuid_generate_v7()` and calls `gen_random_bytes()`. Because that function
-- does not pin a search_path, `gen_random_bytes` may fail to resolve under the
-- managed role's search_path, breaking every default-PK insert.
--
-- This migration makes the generator resolve pgcrypto deterministically by
-- redefining it with an explicit `search_path` that includes `extensions`
-- (Supabase) as well as `public` (local/self-hosted where pgcrypto lives in
-- public). Runs AFTER 20260721000100 (which creates app.uuid_generate_v7) and
-- BEFORE 20260721000200 (which renames it to app.fn_uuid_v7), so it targets the
-- pre-rename name. Behavior (RFC 9562 UUIDv7) is byte-for-byte identical; only
-- name resolution is fixed. Idempotent (create or replace).
-- =====================================================================

-- Ensure pgcrypto exists (no-op if already present). On Supabase it is provided
-- in the extensions schema; locally it may be in public.
create extension if not exists pgcrypto;

create or replace function app.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
set search_path = app, extensions, public
as $$
declare
  ts_ms  bytea;
  buf    bytea;
begin
  ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  buf := ts_ms || gen_random_bytes(10);
  buf := set_byte(buf, 6, (7 << 4) | (get_byte(buf, 6) & 15));
  buf := set_byte(buf, 8, (2 << 6) | (get_byte(buf, 8) & 63));
  return encode(buf, 'hex')::uuid;
end;
$$;

comment on function app.uuid_generate_v7() is
  'RFC 9562 UUIDv7 (time-ordered). Default for all Operro primary keys. '
  'search_path pinned to resolve pgcrypto gen_random_bytes on Supabase '
  '(extensions schema) and self-hosted (public).';
