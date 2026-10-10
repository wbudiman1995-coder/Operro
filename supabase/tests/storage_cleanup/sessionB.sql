-- Session B: tries to start a second apply run for the same organization while A holds its transaction open.
-- It must wait for A (it conflicts on the one-running-apply index) and then be refused, never run alongside A.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims', json_build_object('sub', 'c8f00000-0000-4000-8000-000000000021', 'role', 'authenticated', 'active_org_id', 'c8f00000-0000-4000-8000-000000000001')::text, true);
do $$
declare t0 timestamptz := clock_timestamp(); r jsonb;
begin
  begin
    r := app.storage_cleanup_begin((select id from public.storage_cleanup_runs where organization_id = 'c8f00000-0000-4000-8000-000000000001' and mode = 'dry_run' order by started_at desc limit 1));
    raise exception 'FAIL: second concurrent apply was allowed: %', r;
  exception when sqlstate '55P03' then
    if clock_timestamp() - t0 < interval '1 second' then
      raise exception 'FAIL: second apply was refused without waiting for the first (%)', clock_timestamp() - t0;
    end if;
    raise notice 'PASS: second concurrent apply waited for the first and was refused (after %)', clock_timestamp() - t0;
  end;
end $$;
rollback;
