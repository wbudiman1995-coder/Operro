-- Minimal Supabase Auth/Extensions stubs for disposable PostgreSQL gate DBs.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
-- The gate runner may have already installed pgcrypto in extensions, while
-- older fixtures installed it in public. Do not overwrite its native digest
-- function with a wrapper pointing at a nonexistent public.digest.
do $bootstrap$
declare crypto_schema text;
begin
  select n.nspname into crypto_schema from pg_extension e
  join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if crypto_schema <> 'extensions' then
    execute format('create or replace function extensions.digest(input text, algorithm text) returns bytea language sql immutable as %L',
      format('select %I.digest(input, algorithm)', crypto_schema));
  end if;
end $bootstrap$;
