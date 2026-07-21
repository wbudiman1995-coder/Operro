-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20260721000150_fix_uuidv7_supabase
-- Purpose          Make the UUIDv7 helper portable on Supabase.
-- Context          Supabase installs most extensions in the `extensions`
--                  schema, so the original unqualified gen_random_bytes()
--                  call was not visible through the default search_path.
-- Fix              Use PostgreSQL's core gen_random_uuid() as the entropy
--                  source, avoiding extension-schema dependence entirely.
-- Dependencies     20260721000100_extensions_and_helpers.sql
-- Breaking Changes None.
-- =====================================================================

create or replace function app.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
as $$
declare
  ts_ms       bytea;
  random_tail bytea;
  buf         bytea;
begin
  -- 48-bit big-endian Unix timestamp in milliseconds.
  ts_ms := substring(
    int8send((extract(epoch from clock_timestamp()) * 1000)::bigint)
    from 3
  );

  -- PostgreSQL 16 provides core gen_random_uuid(). Convert its 16 bytes
  -- to bytea and take 10 bytes. The UUIDv7 version and variant bits are
  -- overwritten below, leaving the required random tail.
  random_tail := substring(uuid_send(gen_random_uuid()) from 1 for 10);

  -- 6 timestamp bytes + 10 random bytes = 16 bytes.
  buf := ts_ms || random_tail;

  -- RFC 9562 UUIDv7 version nibble: 0111.
  buf := set_byte(buf, 6, (7 << 4) | (get_byte(buf, 6) & 15));

  -- RFC 4122/RFC 9562 variant bits: 10xx.
  buf := set_byte(buf, 8, (2 << 6) | (get_byte(buf, 8) & 63));

  return encode(buf, 'hex')::uuid;
end;
$$;

comment on function app.uuid_generate_v7() is
  'RFC 9562 UUIDv7 using PostgreSQL core gen_random_uuid() entropy; portable across Supabase extension schemas.';
