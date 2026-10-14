-- Invitation recipients are not authenticated yet. PostgreSQL requires schema
-- USAGE in addition to EXECUTE on the specifically granted preview function.
grant usage on schema app to anon;

-- Make the newly exposed RPC discoverable immediately by PostgREST.
notify pgrst, 'reload schema';

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts.
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101220000'::text;
$$;
