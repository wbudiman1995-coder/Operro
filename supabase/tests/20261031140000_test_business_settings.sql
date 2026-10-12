-- P5 branch calendar hours: validation, concurrency, sibling preservation, authority, tenancy, audit, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031140000_test_business_settings.sql
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
create or replace function pg_temp.token(p_branch uuid) returns timestamptz language sql security definer as $$ select updated_at from public.branches where id = p_branch $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('e5000000-0000-4000-8000-000000000001', 'Hours A', 'hours-a-test', 'active'),
  ('e5000000-0000-4000-8000-000000000002', 'Hours B', 'hours-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e5000000-0000-4000-8000-000000000001'::uuid), ('e5000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e5000000-0000-4000-8000-000000000001'::uuid), ('e5000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status, settings) values
  ('e5000000-0000-4000-8000-0000000000e1', 'e5000000-0000-4000-8000-000000000001', 'North', true, 'active', '{"schedule":{"slotNote":"keep","dayStartMinutes":510},"other":{"k":1}}'),
  ('e5000000-0000-4000-8000-0000000000e3', 'e5000000-0000-4000-8000-000000000001', 'South', false, 'active', '{}'),
  ('e5000000-0000-4000-8000-0000000000e4', 'e5000000-0000-4000-8000-000000000001', 'Closed', false, 'active', '[]'),
  ('e5000000-0000-4000-8000-0000000000e2', 'e5000000-0000-4000-8000-000000000002', 'Main B', true, 'active', '{}');
update public.branches set deleted_at = now() where id = 'e5000000-0000-4000-8000-0000000000e4';
insert into public.roles (id, organization_id, name) values
  ('e5000000-0000-4000-8000-000000000011', 'e5000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e5000000-0000-4000-8000-000000000012', 'e5000000-0000-4000-8000-000000000001', 'BranchMgr'),
  ('e5000000-0000-4000-8000-000000000013', 'e5000000-0000-4000-8000-000000000001', 'SettingsOnly'),
  ('e5000000-0000-4000-8000-000000000014', 'e5000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000012', id from public.permissions where key in ('branches.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000013', id from public.permissions where key in ('settings.manage','booking.read');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e5000000-0000-4000-8000-000000000021', 'owner@hours.test', '{}'),
  ('e5000000-0000-4000-8000-000000000022', 'branchmgr@hours.test', '{}'),
  ('e5000000-0000-4000-8000-000000000023', 'settings@hours.test', '{}'),
  ('e5000000-0000-4000-8000-000000000024', 'owner-b@hours.test', '{}');
update public.users set status = 'active' where id::text like 'e5000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e5000000-0000-4000-8000-0000000000f1', 'e5000000-0000-4000-8000-000000000021', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000011', 'active'),
  ('e5000000-0000-4000-8000-0000000000f2', 'e5000000-0000-4000-8000-000000000022', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000012', 'active'),
  ('e5000000-0000-4000-8000-0000000000f3', 'e5000000-0000-4000-8000-000000000023', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000013', 'active'),
  ('e5000000-0000-4000-8000-0000000000f4', 'e5000000-0000-4000-8000-000000000024', 'e5000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000014', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-0000000000f2', 'e5000000-0000-4000-8000-0000000000e1');

set local role authenticated;
select pg_temp.act_as('e5000000-0000-4000-8000-000000000021', 'e5000000-0000-4000-8000-000000000001');
do $$
declare t1 timestamptz; t2 timestamptz; s jsonb;
begin
  t1 := pg_temp.token('e5000000-0000-4000-8000-0000000000e1');
  t2 := app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e1', 480, 1200, t1);
  select settings into s from public.branches where id = 'e5000000-0000-4000-8000-0000000000e1';
  perform pg_temp.check((s #>> '{schedule,dayStartMinutes}')::int = 480 and (s #>> '{schedule,dayEndMinutes}')::int = 1200, 'owner sets 08:00-20:00');
  perform pg_temp.check(s #>> '{schedule,slotNote}' = 'keep' and s #>> '{other,k}' = '1', 'sibling keys inside schedule and beside it are preserved');
  -- (updated_at is now(), the transaction time: it only moves between transactions, so a stale token is simulated by an older value)
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 600, 1140, %L)', 'e5000000-0000-4000-8000-0000000000e1', t1 - interval '1 second'), '40001', 'a stale token (another change happened) is refused');
  perform pg_temp.check((select (settings #>> '{schedule,dayStartMinutes}')::int from public.branches where id = 'e5000000-0000-4000-8000-0000000000e1') = 480, 'and nothing was written');
  -- validation
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 500, 1100, %L)', 'e5000000-0000-4000-8000-0000000000e1', t2), '22023', 'not a quarter hour');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 600, 660, %L)', 'e5000000-0000-4000-8000-0000000000e1', t2), '22023', 'shorter than two hours');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 600, 1500, %L)', 'e5000000-0000-4000-8000-0000000000e1', t2), '22023', 'end beyond midnight');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, -15, 600, %L)', 'e5000000-0000-4000-8000-0000000000e1', t2), '22023', 'negative start');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 1380, 1440, %L)', 'e5000000-0000-4000-8000-0000000000e1', t2), '22023', 'start too late for a two-hour day');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 900, 600, %L)', 'e5000000-0000-4000-8000-0000000000e1', t2), '22023', 'end before start');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 600, null, %L)', 'e5000000-0000-4000-8000-0000000000e1', t2), '22023', 'only one of the two values');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 600, 1140, null)', 'e5000000-0000-4000-8000-0000000000e1'), '22023', 'a missing concurrency token is refused');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(null, 600, 1140, %L)', t2), '42501', 'null branch refused');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 600, 1140, %L)', 'e5000000-0000-4000-8000-0000000000e4', now()), 'P0002', 'a deleted branch is not found');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 600, 1140, %L)', 'e5000000-0000-4000-8000-0000000000e2', now()), 'P0002', 'another tenant''s branch is not found');
  -- reset removes only the two keys; an emptied schedule object is dropped, siblings elsewhere stay
  t1 := pg_temp.token('e5000000-0000-4000-8000-0000000000e1');
  perform app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e1', null, null, t1);
  select settings into s from public.branches where id = 'e5000000-0000-4000-8000-0000000000e1';
  perform pg_temp.check(not (s -> 'schedule' ? 'dayStartMinutes') and not (s -> 'schedule' ? 'dayEndMinutes') and s #>> '{schedule,slotNote}' = 'keep' and s #>> '{other,k}' = '1', 'reset drops only the two keys');
  t1 := pg_temp.token('e5000000-0000-4000-8000-0000000000e3');
  perform app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e3', 540, 1140, t1);
  perform app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e3', null, null, pg_temp.token('e5000000-0000-4000-8000-0000000000e3'));
  perform pg_temp.check((select settings from public.branches where id = 'e5000000-0000-4000-8000-0000000000e3') = '{}'::jsonb, 'resetting a branch with nothing else leaves clean settings');
  -- boundary values accepted
  perform app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e3', 0, 120, pg_temp.token('e5000000-0000-4000-8000-0000000000e3'));
  perform app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e3', 1320, 1440, pg_temp.token('e5000000-0000-4000-8000-0000000000e3'));
  perform pg_temp.check((select (settings #>> '{schedule,dayEndMinutes}')::int from public.branches where id = 'e5000000-0000-4000-8000-0000000000e3') = 1440, 'the 00:00-02:00 and 22:00-24:00 boundaries are accepted');
end $$;
-- a non-object branch settings value is repaired, not crashed on
reset role;
update public.branches set settings = '[]' where id = 'e5000000-0000-4000-8000-0000000000e3';
set local role authenticated;
select pg_temp.act_as('e5000000-0000-4000-8000-000000000021', 'e5000000-0000-4000-8000-000000000001');
do $$ begin
  perform app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e3', 480, 1080, pg_temp.token('e5000000-0000-4000-8000-0000000000e3'));
  perform pg_temp.check((select settings from public.branches where id = 'e5000000-0000-4000-8000-0000000000e3') = '{"schedule":{"dayStartMinutes":480,"dayEndMinutes":1080}}'::jsonb, 'a malformed settings value is replaced by a valid object');
end $$;

-- ===== Authority ===========================================================================================================
select pg_temp.act_as('e5000000-0000-4000-8000-000000000022', 'e5000000-0000-4000-8000-000000000001');
do $$ begin
  perform app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e1', 540, 1140, pg_temp.token('e5000000-0000-4000-8000-0000000000e1'));
  perform pg_temp.check((select (settings #>> '{schedule,dayStartMinutes}')::int from public.branches where id = 'e5000000-0000-4000-8000-0000000000e1') = 540, 'a branches.manage member changes their own branch');
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 540, 1140, %L)', 'e5000000-0000-4000-8000-0000000000e3', pg_temp.token('e5000000-0000-4000-8000-0000000000e3')), '42501', 'but not a branch they cannot access');
end $$;
select pg_temp.act_as('e5000000-0000-4000-8000-000000000023', 'e5000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 540, 1140, %L)', 'e5000000-0000-4000-8000-0000000000e1', pg_temp.token('e5000000-0000-4000-8000-0000000000e1')), '42501', 'settings.manage alone is not enough');
end $$;
select pg_temp.act_as('e5000000-0000-4000-8000-000000000024', 'e5000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 540, 1140, %L)', 'e5000000-0000-4000-8000-0000000000e1', now()), 'P0002', 'tenant B''s owner cannot touch tenant A''s branch (not found in their organization)');
  perform pg_temp.check(app.set_branch_calendar_hours('e5000000-0000-4000-8000-0000000000e2', 540, 1140, pg_temp.token('e5000000-0000-4000-8000-0000000000e2')) is not null, 'but sets their own');
end $$;
select pg_temp.act_as('e5000000-0000-4000-8000-000000000021', 'e5000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect(format('select app.set_branch_calendar_hours(%L, 540, 1140, %L)', 'e5000000-0000-4000-8000-0000000000e2', now()), '42501', 'forged active organization refused');
end $$;

-- ===== Audit and grants ======================================================================================================
reset role;
do $$
declare f oid; v_cfg text[];
begin
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'branches' and action = 'UPDATE' and entity_id = 'e5000000-0000-4000-8000-0000000000e1') >= 3, 'every hours change is an audited branch update');
  perform pg_temp.check((select actor_id from app.audit_log where entity_table = 'branches' and action = 'UPDATE' and entity_id = 'e5000000-0000-4000-8000-0000000000e1' order by occurred_at desc, id desc limit 1) = 'e5000000-0000-4000-8000-000000000022', 'with the acting user');
  select p.oid, p.proconfig into f, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'set_branch_calendar_hours';
  perform pg_temp.check(v_cfg = array['search_path=""'] and not has_function_privilege('anon', f, 'execute') and has_function_privilege('authenticated', f, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f and a.grantee = 0), 'definer with an empty search_path; anon/PUBLIC denied; authenticated granted');
  perform pg_temp.check(app.schema_version() >= '20261031140000', 'schema version moved to (or past) this migration');
end $$;
rollback;
