-- P8 health signals: export verification / retention / consent signals, tenant isolation, redaction, owner gate.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031160000_test_health_signals.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'active_org_id', o)::text, true); end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_label; end if; raise notice 'PASS: %', p_label; end $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('e8000000-0000-4000-8000-000000000001', 'Health A', 'health-a-test', 'active'),
  ('e8000000-0000-4000-8000-000000000002', 'Health B', 'health-b-test', 'active');
insert into public.roles (id, organization_id, name) values
  ('e8000000-0000-4000-8000-000000000011', 'e8000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e8000000-0000-4000-8000-000000000012', 'e8000000-0000-4000-8000-000000000001', 'Manager'),
  ('e8000000-0000-4000-8000-000000000013', 'e8000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000012', id from public.permissions where key in ('settings.manage','reports.view');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e8000000-0000-4000-8000-000000000021', 'owner-a@health.test', '{}'), ('e8000000-0000-4000-8000-000000000022', 'manager-a@health.test', '{}'),
  ('e8000000-0000-4000-8000-000000000023', 'owner-b@health.test', '{}');
update public.users set status = 'active' where id::text like 'e8000000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000011', 'active'),
  ('e8000000-0000-4000-8000-000000000022', 'e8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000012', 'active'),
  ('e8000000-0000-4000-8000-000000000023', 'e8000000-0000-4000-8000-000000000002', 'e8000000-0000-4000-8000-000000000013', 'active');

set local role authenticated;
select pg_temp.act_as('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000001');
do $$
declare h jsonb;
begin
  h := app.health_summary();
  perform pg_temp.check((h #>> '{exports,completed_archives}')::int = 0 and (h #>> '{exports,unverified_completed}')::int = 0 and h #> '{exports,last_verification_ok}' = 'null'::jsonb and (h #>> '{exports,purge_candidates}')::int = 0 and h #> '{exports,newest_completed_at}' = 'null'::jsonb, 'a workspace with no archive reports zeros and nulls (no archive is not a failure)');
  perform pg_temp.check((h #>> '{cleanup,schedule_consent}')::boolean is false, 'unattended cleanup consent defaults to false');
end $$;
reset role;
insert into public.organization_export_jobs(id, organization_id, status, storage_prefix, created_by, created_at, completed_at, manifest, verified_at, verified_ok, verified_failures, purged_at) values
  ('e8000000-0000-4000-8000-0000000000a1', 'e8000000-0000-4000-8000-000000000001', 'completed', 'a/1', 'e8000000-0000-4000-8000-000000000021', now() - interval '200 days', now() - interval '200 days', '{}', null, null, null, null),
  ('e8000000-0000-4000-8000-0000000000a2', 'e8000000-0000-4000-8000-000000000001', 'completed', 'a/2', 'e8000000-0000-4000-8000-000000000021', now() - interval '3 days', now() - interval '3 days', '{}', now() - interval '2 days', false, 4, null),
  ('e8000000-0000-4000-8000-0000000000a3', 'e8000000-0000-4000-8000-000000000001', 'completed', 'a/3', 'e8000000-0000-4000-8000-000000000021', now() - interval '300 days', now() - interval '300 days', '{}', now() - interval '299 days', true, 0, now() - interval '100 days'),
  ('e8000000-0000-4000-8000-0000000000a4', 'e8000000-0000-4000-8000-000000000001', 'failed', 'a/4', 'e8000000-0000-4000-8000-000000000021', now() - interval '20 days', now() - interval '20 days', null, null, null, null, null),
  ('e8000000-0000-4000-8000-0000000000b1', 'e8000000-0000-4000-8000-000000000002', 'completed', 'b/1', 'e8000000-0000-4000-8000-000000000023', now() - interval '1 day', now() - interval '1 day', '{}', now(), true, 0, null);
set local role authenticated;
select pg_temp.act_as('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000001');
do $$
declare h jsonb;
begin
  h := app.health_summary();
  perform pg_temp.check((h #>> '{exports,completed_archives}')::int = 2, 'two completed archives still have files (the purged one is excluded)');
  perform pg_temp.check((h #>> '{exports,unverified_completed}')::int = 2, 'both are unverified or failed their last verification (the purged one is not counted)');
  perform pg_temp.check((h #>> '{exports,last_verification_ok}')::boolean is false, 'the most recent recorded verification failed');
  perform pg_temp.check((h #>> '{exports,purge_candidates}')::int = 2, 'candidates: the failed 20-day job and the 200-day archive (the 3-day one is the newest and stays)');
  perform pg_temp.check((h #>> '{exports,newest_completed_at}')::timestamptz > now() - interval '4 days', 'newest completed archive time');
  perform pg_temp.check((h #>> '{exports,failed_30d}')::int = 1, 'existing signal unchanged: failed exports in 30 days');
  perform pg_temp.check(not (h::text ~* '(storage_prefix|a/[0-9]|manifest|token|secret|password|credential|signed|failed_reason|service_role|postgres://)'), 'no path, manifest, credential or raw reason is exposed');
  perform pg_temp.check(not (h ? 'platform'), 'a business owner receives no platform section');
  perform app.set_storage_cleanup_schedule(true, 'weekly');
  perform pg_temp.check((app.health_summary() #>> '{cleanup,schedule_consent}')::boolean is true, 'recorded cleanup consent is reflected (consent only)');
  perform app.set_storage_cleanup_schedule(false);
  perform pg_temp.check((app.health_summary() #>> '{cleanup,schedule_consent}')::boolean is false, 'and withdrawal is reflected at once');
end $$;
select pg_temp.act_as('e8000000-0000-4000-8000-000000000022', 'e8000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect('select app.health_summary()', '42501', 'a manager with settings.manage and reports.view is refused');
end $$;
select pg_temp.act_as('e8000000-0000-4000-8000-000000000023', 'e8000000-0000-4000-8000-000000000002');
do $$
declare h jsonb;
begin
  h := app.health_summary();
  perform pg_temp.check((h #>> '{exports,completed_archives}')::int = 1 and (h #>> '{exports,unverified_completed}')::int = 0 and (h #>> '{exports,last_verification_ok}')::boolean is true and (h #>> '{exports,purge_candidates}')::int = 0, 'tenant B sees only its own verified archive');
  perform pg_temp.check((h #>> '{cleanup,schedule_consent}')::boolean is false, 'and its own (default off) consent');
end $$;
select pg_temp.act_as('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect('select app.health_summary()', '42501', 'forged active organization refused');
end $$;
reset role;
do $$ begin
  perform pg_temp.check(not has_function_privilege('anon', 'app.health_summary()', 'execute') and has_function_privilege('authenticated', 'app.health_summary()', 'execute'), 'grants unchanged: anon denied, authenticated granted');
  perform pg_temp.check((select proconfig = array['search_path=""'] and prosecdef from pg_proc where oid = 'app.health_summary()'::regprocedure), 'still definer with an empty search_path');
  perform pg_temp.check(app.schema_version() >= '20261031160000', 'schema version moved to (or past) this migration');
end $$;
rollback;
