\set ON_ERROR_STOP on
begin;

insert into public.organizations(id,name,slug,status) values
  ('a4210000-0000-4000-8000-000000000001','Dashboard A','dashboard-a-test','active'),
  ('a4210000-0000-4000-8000-000000000002','Dashboard B','dashboard-b-test','active');
insert into public.roles(id,organization_id,name) values
  ('a4210000-0000-4000-8000-000000000011','a4210000-0000-4000-8000-000000000001','Manager'),
  ('a4210000-0000-4000-8000-000000000012','a4210000-0000-4000-8000-000000000001','Reader');
insert into public.role_permissions(role_id,organization_id,permission_id)
select 'a4210000-0000-4000-8000-000000000011','a4210000-0000-4000-8000-000000000001',id
from public.permissions where key = 'settings.manage';
insert into auth.users(id,email,raw_user_meta_data) values
  ('a4210000-0000-4000-8000-000000000021','dashboard-manager@example.test','{}'),
  ('a4210000-0000-4000-8000-000000000022','dashboard-reader@example.test','{}');
update public.users set status='active' where id in
  ('a4210000-0000-4000-8000-000000000021','a4210000-0000-4000-8000-000000000022');
insert into public.memberships(user_id,organization_id,role_id,status) values
  ('a4210000-0000-4000-8000-000000000021','a4210000-0000-4000-8000-000000000001','a4210000-0000-4000-8000-000000000011','active'),
  ('a4210000-0000-4000-8000-000000000022','a4210000-0000-4000-8000-000000000001','a4210000-0000-4000-8000-000000000012','active');

-- Fixture writes go through a definer so they bypass RLS/column grants like a platform migration would;
-- the function under test is always called as the real authenticated role.
create function pg_temp.seed_settings(p_org uuid, p_settings jsonb) returns void
language sql security definer as $$ update public.organizations set settings = p_settings where id = p_org $$;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a4210000-0000-4000-8000-000000000021","active_org_id":"a4210000-0000-4000-8000-000000000001","role":"authenticated"}',true);

do $$
declare v jsonb;
begin
  if app.fn_active_organization() is distinct from 'a4210000-0000-4000-8000-000000000001'::uuid
     or not app.has_permission('settings.manage') then raise exception 'manager fixture is not authorized'; end if;

  perform app.update_dashboard_card_settings('{"booking_today":false,"revenue_today":true,"active_customers":true,"open_tasks":false}'::jsonb);
  select settings into v from public.organizations where id = app.fn_active_organization();
  if v #> '{dashboard,cards}' is distinct from '{"booking_today":false,"revenue_today":true,"active_customers":true,"open_tasks":false}'::jsonb then
    raise exception 'empty settings did not create cards: %', v; end if;

  perform pg_temp.seed_settings(app.fn_active_organization(), '{"documents":{"tagline":"hello"},"dashboard":{"layout":"compact","cards":{"open_tasks":true}}}'::jsonb);
  perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":false,"active_customers":true,"open_tasks":true}'::jsonb);
  select settings into v from public.organizations where id = app.fn_active_organization();
  if v #>> '{documents,tagline}' is distinct from 'hello' or v #>> '{dashboard,layout}' is distinct from 'compact'
     or v #> '{dashboard,cards}' is distinct from '{"booking_today":true,"revenue_today":false,"active_customers":true,"open_tasks":true}'::jsonb then
    raise exception 'sibling preservation or replacement failed: %', v; end if;

  perform pg_temp.seed_settings(app.fn_active_organization(), '"malformed"'::jsonb);
  perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":false,"open_tasks":true}'::jsonb);
  select settings into v from public.organizations where id = app.fn_active_organization();
  if v #>> '{dashboard,cards,active_customers}' is distinct from 'false' then
    raise exception 'scalar settings normalization failed: %', v; end if;

  perform pg_temp.seed_settings(app.fn_active_organization(), '{"documents":{"x":1},"dashboard":"malformed"}'::jsonb);
  perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":false}'::jsonb);
  select settings into v from public.organizations where id = app.fn_active_organization();
  if v #>> '{documents,x}' is distinct from '1' or v #>> '{dashboard,cards,open_tasks}' is distinct from 'false' then
    raise exception 'dashboard normalization failed: %', v; end if;

  begin
    perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"unknown":true}'::jsonb);
    raise exception 'extra key accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform app.update_dashboard_card_settings('{"booking_today":false}'::jsonb);
    raise exception 'partial allowlist accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":null}'::jsonb);
    raise exception 'null card accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform app.update_dashboard_card_settings('{"unknown":true}'::jsonb);
    raise exception 'unknown key accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform app.update_dashboard_card_settings('{"booking_today":"yes","revenue_today":true,"active_customers":true,"open_tasks":true}'::jsonb);
    raise exception 'non-boolean accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform app.update_dashboard_card_settings('[]'::jsonb);
    raise exception 'array accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform app.update_dashboard_card_settings('true'::jsonb);
    raise exception 'scalar accepted';
  exception when sqlstate '22023' then null; end;
end $$;

-- A's manager cannot switch the claim to B and write without B membership.
select set_config('request.jwt.claims','{"sub":"a4210000-0000-4000-8000-000000000021","active_org_id":"a4210000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $$
begin
  begin
    perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true}'::jsonb);
    raise exception 'cross-tenant update accepted';
  exception when sqlstate '42501' then null; end;
end $$;

select set_config('request.jwt.claims','{"sub":"a4210000-0000-4000-8000-000000000022","active_org_id":"a4210000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $$
begin
  if app.has_permission('settings.manage') then raise exception 'reader unexpectedly has permission'; end if;
  begin
    perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true}'::jsonb);
    raise exception 'reader update accepted';
  exception when sqlstate '42501' then null; end;
end $$;

set local role anon;
do $$
begin
  begin
    perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true}'::jsonb);
    raise exception 'anon execute accepted';
  exception when sqlstate '42501' then null; end;
end $$;

reset role;
do $$
declare v jsonb;
begin
  select settings into v from public.organizations where id = 'a4210000-0000-4000-8000-000000000002';
  if v is distinct from '{}'::jsonb then raise exception 'other tenant changed: %', v; end if;
end $$;

do $$
declare v_acl text; v_cfg text[];
begin
  select proconfig into v_cfg from pg_proc where oid='app.update_dashboard_card_settings(jsonb)'::regprocedure;
  if v_cfg is distinct from array['search_path=""'] then raise exception 'search_path not empty: %', v_cfg; end if;
  if has_function_privilege('anon','app.update_dashboard_card_settings(jsonb)','execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid='app.update_dashboard_card_settings(jsonb)'::regprocedure and a.grantee=0)
     or not has_function_privilege('authenticated','app.update_dashboard_card_settings(jsonb)','execute') then
    raise exception 'grant shape wrong'; end if;
  raise notice 'PASS dashboard card settings: complete allowlist, tenant/capability denial, sibling preservation, grants';
end $$;

rollback;
