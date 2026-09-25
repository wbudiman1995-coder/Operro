-- Minimal Supabase Auth/Extensions stubs for disposable PostgreSQL gate DBs.
create extension if not exists pgcrypto with schema public;
create schema if not exists extensions;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function extensions.digest(input text, algorithm text)
returns bytea language sql immutable as $$ select public.digest(input, algorithm) $$;
