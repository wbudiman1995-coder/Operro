-- Session A: starts the apply run and holds its transaction open for 4 seconds.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims', json_build_object('sub', 'c8f00000-0000-4000-8000-000000000021', 'role', 'authenticated', 'active_org_id', 'c8f00000-0000-4000-8000-000000000001')::text, true);
do $$
declare r jsonb;
begin
  r := app.storage_cleanup_begin((select id from public.storage_cleanup_runs where organization_id = 'c8f00000-0000-4000-8000-000000000001' and mode = 'dry_run' order by started_at desc limit 1));
  if (r ->> 'marked')::int <> 2 then raise exception 'session A marked % items, expected 2', r ->> 'marked'; end if;
  raise notice 'A started run %', r ->> 'run_id';
end $$;
select pg_sleep(4);
commit;
