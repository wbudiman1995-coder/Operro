\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.act_as(p_user uuid, p_org uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'active_org_id', p_org)::text, true);
end $$;

create or replace function pg_temp.expect(p_sql text, p_state text, p_message text) returns void
language plpgsql as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state = p_state then raise notice 'PASS: %', p_message; return; end if;
    raise exception 'FAIL: % (expected %, got %: %)', p_message, p_state, v_state, sqlerrm;
  end;
  raise exception 'FAIL: % (expected %, got success)', p_message, p_state;
end $$;

insert into public.organizations(id, name, slug, status) values
  ('d3110000-0000-4000-8000-000000000001', 'Payroll Guard A', 'payroll-guard-a', 'active'),
  ('d3110000-0000-4000-8000-000000000002', 'Payroll Guard B', 'payroll-guard-b', 'active');
insert into public.branches(id, organization_id, name, is_default, status, timezone) values
  ('d3110000-0000-4000-8000-000000000011', 'd3110000-0000-4000-8000-000000000001', 'A', true, 'active', 'Asia/Jakarta'),
  ('d3110000-0000-4000-8000-000000000012', 'd3110000-0000-4000-8000-000000000002', 'B', true, 'active', 'Asia/Jakarta');
insert into auth.users(id) values
  ('d3110000-0000-4000-8000-000000000021'),
  ('d3110000-0000-4000-8000-000000000022'),
  ('d3110000-0000-4000-8000-000000000023') on conflict do nothing;
insert into public.users(id, full_name, email, status) values
  ('d3110000-0000-4000-8000-000000000021', 'Payroll Reader A', 'reader-a@guard.test', 'active'),
  ('d3110000-0000-4000-8000-000000000022', 'No Payroll A', 'no-payroll-a@guard.test', 'active'),
  ('d3110000-0000-4000-8000-000000000023', 'Payroll Reader B', 'reader-b@guard.test', 'active')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, status = excluded.status;
insert into public.roles(id, organization_id, name, is_system) values
  ('d3110000-0000-4000-8000-000000000031', 'd3110000-0000-4000-8000-000000000001', 'Reader A', false),
  ('d3110000-0000-4000-8000-000000000032', 'd3110000-0000-4000-8000-000000000001', 'No payroll A', false),
  ('d3110000-0000-4000-8000-000000000033', 'd3110000-0000-4000-8000-000000000002', 'Reader B', false);
insert into public.memberships(id, organization_id, user_id, role_id, status) values
  ('d3110000-0000-4000-8000-000000000041', 'd3110000-0000-4000-8000-000000000001', 'd3110000-0000-4000-8000-000000000021', 'd3110000-0000-4000-8000-000000000031', 'active'),
  ('d3110000-0000-4000-8000-000000000042', 'd3110000-0000-4000-8000-000000000001', 'd3110000-0000-4000-8000-000000000022', 'd3110000-0000-4000-8000-000000000032', 'active'),
  ('d3110000-0000-4000-8000-000000000043', 'd3110000-0000-4000-8000-000000000002', 'd3110000-0000-4000-8000-000000000023', 'd3110000-0000-4000-8000-000000000033', 'active');
insert into public.permissions(key, resource, action, description)
values ('payroll.read', 'payroll', 'read', 'Read payroll') on conflict (key) do nothing;
insert into public.role_permissions(organization_id, role_id, permission_id)
select r.organization_id, r.id, p.id
  from public.roles r cross join public.permissions p
 where r.id in ('d3110000-0000-4000-8000-000000000031', 'd3110000-0000-4000-8000-000000000033')
   and p.key = 'payroll.read';
insert into public.organization_modules(organization_id, module_id, enabled)
select o.id, m.id, true from public.organizations o cross join public.modules m
 where o.id in ('d3110000-0000-4000-8000-000000000001', 'd3110000-0000-4000-8000-000000000002')
   and m.key = 'payroll'
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.payroll_cycle_settings(organization_id, cycle_start_day)
values ('d3110000-0000-4000-8000-000000000001', 26), ('d3110000-0000-4000-8000-000000000002', 1);

set local role authenticated;
select pg_temp.act_as('d3110000-0000-4000-8000-000000000021', 'd3110000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from app.payroll_cycle_bounds('d3110000-0000-4000-8000-000000000001', '2026-10-12');
  if r.period_start <> date '2026-09-26' or r.period_end <> date '2026-10-26' then
    raise exception 'FAIL: authorized cycle result %', row_to_json(r);
  end if;
  perform 1 from app.payroll_missing_invoice_pets('d3110000-0000-4000-8000-000000000001', '2026-09-26', '2026-10-26');
  raise notice 'PASS: payroll.read can use both guarded read helpers for its active tenant';
end $$;
select pg_temp.expect($q$select * from app.payroll_cycle_bounds('d3110000-0000-4000-8000-000000000002', '2026-10-12')$q$, '42501', 'cross-tenant cycle request denied');
select pg_temp.expect($q$select * from app.payroll_missing_invoice_pets('d3110000-0000-4000-8000-000000000002', '2026-09-26', '2026-10-26')$q$, '42501', 'cross-tenant missing-invoice request denied');
select pg_temp.expect($q$select * from app.payroll_missing_invoice_pets('d3110000-0000-4000-8000-000000000001', '2026-10-26', '2026-09-26')$q$, '22023', 'invalid payroll period denied');

select pg_temp.act_as('d3110000-0000-4000-8000-000000000022', 'd3110000-0000-4000-8000-000000000001');
select pg_temp.expect($q$select * from app.payroll_cycle_bounds('d3110000-0000-4000-8000-000000000001', '2026-10-12')$q$, '42501', 'member without payroll.read denied cycle bounds');
select pg_temp.expect($q$select * from app.payroll_missing_invoice_pets('d3110000-0000-4000-8000-000000000001', '2026-09-26', '2026-10-26')$q$, '42501', 'member without payroll.read denied missing-invoice rows');

reset role;
do $$
declare f text;
begin
  foreach f in array array[
    'app.org_timezone(uuid)', 'app.org_today(uuid)',
    'app.payroll_working_day_stats(uuid,uuid,date,date)',
    'app.payroll_eligible_pets(uuid,date,date)',
    'app.payroll_transport_shares(uuid,date,date)'
  ] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
       or has_function_privilege('public', f, 'execute') then
      raise exception 'FAIL: internal helper is browser-callable: %', f;
    end if;
  end loop;
  foreach f in array array[
    'app.org_timezone(uuid)', 'app.org_today(uuid)', 'app.payroll_cycle_bounds(uuid,date)',
    'app.payroll_working_day_stats(uuid,uuid,date,date)', 'app.payroll_eligible_pets(uuid,date,date)',
    'app.payroll_missing_invoice_pets(uuid,date,date)', 'app.payroll_transport_shares(uuid,date,date)'
  ] loop
    if (select p.proconfig from pg_proc p where p.oid = f::regprocedure) is distinct from array['search_path=""'] then
      raise exception 'FAIL: helper search_path is not empty: %', f;
    end if;
  end loop;
  if app.schema_version() < '20261030110000' then raise exception 'FAIL: schema version %', app.schema_version(); end if;
  raise notice 'PASS: internal grants removed; every remaining payroll read helper has an empty search_path';
end $$;

rollback;
