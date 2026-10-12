-- P7 unattended-cleanup consent: off by default, owner-only, instant disable, audited, no runner implied.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031150000_test_cleanup_schedule_consent.sql
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
create or replace function pg_temp.rows_for(p_org uuid) returns integer language sql security definer as $$ select count(*)::integer from public.storage_cleanup_schedules where organization_id = p_org $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('e7000000-0000-4000-8000-000000000001', 'Sched A', 'sched-a-test', 'active'),
  ('e7000000-0000-4000-8000-000000000002', 'Sched B', 'sched-b-test', 'active');
insert into public.roles (id, organization_id, name) values
  ('e7000000-0000-4000-8000-000000000011', 'e7000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e7000000-0000-4000-8000-000000000012', 'e7000000-0000-4000-8000-000000000001', 'Manager'),
  ('e7000000-0000-4000-8000-000000000013', 'e7000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000012', id from public.permissions where key in ('settings.manage','reports.view');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7000000-0000-4000-8000-000000000021', 'owner-a@sched.test', '{}'), ('e7000000-0000-4000-8000-000000000022', 'manager-a@sched.test', '{}'),
  ('e7000000-0000-4000-8000-000000000023', 'owner-b@sched.test', '{}');
update public.users set status = 'active' where id::text like 'e7000000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000011', 'active'),
  ('e7000000-0000-4000-8000-000000000022', 'e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000012', 'active'),
  ('e7000000-0000-4000-8000-000000000023', 'e7000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000013', 'active');

set local role authenticated;
select pg_temp.act_as('e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000001');
do $$
declare s jsonb;
begin
  s := app.storage_cleanup_schedule_state();
  perform pg_temp.check((s ->> 'enabled')::boolean is false and s ->> 'cadence' = 'weekly' and s -> 'changed_at' = 'null'::jsonb, 'a workspace that never opted in is OFF, with no change history');
  perform pg_temp.check(pg_temp.rows_for('e7000000-0000-4000-8000-000000000001') = 0, 'and has no schedule row at all (off is the absence of consent)');
  perform pg_temp.check(not (s ? 'next_run_at') and not (s::text ~* 'next'), 'the state carries no next-run time because no runner exists');
  perform app.set_storage_cleanup_schedule(true, 'monthly');
  s := app.storage_cleanup_schedule_state();
  perform pg_temp.check((s ->> 'enabled')::boolean and s ->> 'cadence' = 'monthly' and s ->> 'changed_at' is not null and s -> 'disabled_at' = 'null'::jsonb, 'the owner records consent for a cadence');
  perform pg_temp.check((select enabled and cadence = 'monthly' from public.storage_cleanup_schedules), 'visible to the owner');
  perform app.set_storage_cleanup_schedule(false);
  s := app.storage_cleanup_schedule_state();
  perform pg_temp.check(not (s ->> 'enabled')::boolean and s ->> 'disabled_at' is not null, 'disabling is immediate and stamps when');
  perform app.set_storage_cleanup_schedule(false, 'weekly');
  perform pg_temp.check(pg_temp.rows_for('e7000000-0000-4000-8000-000000000001') = 1, 'repeating a setting never duplicates the row');
  perform pg_temp.expect($q$select app.set_storage_cleanup_schedule(true, 'hourly')$q$, '22023', 'an unknown cadence is refused (no sub-weekly runs exist)');
  perform pg_temp.expect($q$select app.set_storage_cleanup_schedule(null, 'weekly')$q$, '22023', 'a null switch is refused');
  perform pg_temp.expect($q$select app.set_storage_cleanup_schedule(true, null)$q$, '22023', 'a null cadence is refused');
  perform pg_temp.expect($q$update public.storage_cleanup_schedules set enabled = true$q$, '42501', 'clients cannot flip the switch with a direct UPDATE');
  perform pg_temp.expect($q$insert into public.storage_cleanup_schedules(organization_id, enabled) values (app.fn_active_organization(), true)$q$, '42501', 'nor insert a row');
  perform pg_temp.expect($q$delete from public.storage_cleanup_schedules$q$, '42501', 'nor delete one');
end $$;
select pg_temp.act_as('e7000000-0000-4000-8000-000000000022', 'e7000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect('select app.set_storage_cleanup_schedule(true)', '42501', 'a manager with settings.manage cannot give consent');
  perform pg_temp.expect('select app.storage_cleanup_schedule_state()', '42501', 'nor read the schedule state');
  perform pg_temp.check((select count(*) from public.storage_cleanup_schedules) = 0, 'and sees no schedule rows');
end $$;
select pg_temp.act_as('e7000000-0000-4000-8000-000000000023', 'e7000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.check((select count(*) from public.storage_cleanup_schedules) = 0, 'tenant B sees none of tenant A''s consent');
  perform pg_temp.check(not (app.storage_cleanup_schedule_state() ->> 'enabled')::boolean, 'tenant B is off');
end $$;
select pg_temp.act_as('e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect('select app.set_storage_cleanup_schedule(true)', '42501', 'forged active organization refused');
end $$;
reset role;
do $$
declare f oid;
begin
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'storage_cleanup_schedules') >= 3, 'every consent change is audited (insert and updates)');
  perform pg_temp.check((select actor_id from app.audit_log where entity_table = 'storage_cleanup_schedules' order by occurred_at desc, id desc limit 1) = 'e7000000-0000-4000-8000-000000000021', 'with the acting owner');
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in ('set_storage_cleanup_schedule','storage_cleanup_schedule_state') loop
    perform pg_temp.check((select proconfig = array['search_path=""'] and prosecdef from pg_proc where oid = f) and not has_function_privilege('anon', f, 'execute') and has_function_privilege('authenticated', f, 'execute'), (select proname from pg_proc where oid = f) || ': definer, empty search_path, anon denied');
  end loop;
  perform pg_temp.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','public') and p.prosrc ~* '(pg_cron|cron\.schedule|http_post|net\.http_)'), 'no function in the database schedules or calls anything');
  perform pg_temp.check(app.schema_version() >= '20261031150000', 'schema version moved to (or past) this migration');
end $$;
rollback;
