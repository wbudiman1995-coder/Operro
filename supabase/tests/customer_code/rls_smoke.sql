\set ON_ERROR_STOP on

insert into auth.users (id, email, email_confirmed_at) values
  ('c0000000-0000-4000-8000-000000000001','cc-owner-a@example.test',now()),
  ('c0000000-0000-4000-8000-000000000002','cc-owner-b@example.test',now()),
  ('c0000000-0000-4000-8000-000000000003','cc-reader@example.test',now())
on conflict (id) do nothing;

insert into public.organizations (id,name,slug,status) values
  ('0c300000-0000-4000-8000-000000000001','Customer Code A','customer-code-a','active'),
  ('0c300000-0000-4000-8000-000000000002','Customer Code B','customer-code-b','active')
on conflict (id) do nothing;

insert into public.branches (id,organization_id,name,is_default,status) values
  ('0c300000-0000-4000-8000-0000000000a1','0c300000-0000-4000-8000-000000000001','Main',true,'active'),
  ('0c300000-0000-4000-8000-0000000000a2','0c300000-0000-4000-8000-000000000002','Main',true,'active')
on conflict (id) do nothing;

insert into public.roles (id,organization_id,name,is_system) values
  ('0c300000-0000-4000-8000-0000000000e1','0c300000-0000-4000-8000-000000000001','Owner',true),
  ('0c300000-0000-4000-8000-0000000000e2','0c300000-0000-4000-8000-000000000002','Owner',true),
  ('0c300000-0000-4000-8000-0000000000e3','0c300000-0000-4000-8000-000000000001','Reader',true)
on conflict (id) do nothing;

insert into public.memberships (id,organization_id,user_id,role_id,status) values
  ('0c300000-0000-4000-8000-0000000000d1','0c300000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','0c300000-0000-4000-8000-0000000000e1','active'),
  ('0c300000-0000-4000-8000-0000000000d2','0c300000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002','0c300000-0000-4000-8000-0000000000e2','active'),
  ('0c300000-0000-4000-8000-0000000000d3','0c300000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000003','0c300000-0000-4000-8000-0000000000e3','active')
on conflict (id) do nothing;

insert into public.membership_branch_access (organization_id,membership_id,branch_id) values
  ('0c300000-0000-4000-8000-000000000001','0c300000-0000-4000-8000-0000000000d1','0c300000-0000-4000-8000-0000000000a1'),
  ('0c300000-0000-4000-8000-000000000002','0c300000-0000-4000-8000-0000000000d2','0c300000-0000-4000-8000-0000000000a2'),
  ('0c300000-0000-4000-8000-000000000001','0c300000-0000-4000-8000-0000000000d3','0c300000-0000-4000-8000-0000000000a1')
on conflict do nothing;

insert into public.role_permissions (organization_id,role_id,permission_id)
select '0c300000-0000-4000-8000-000000000001','0c300000-0000-4000-8000-0000000000e1',id
  from public.permissions where key in ('customer.read','customer.manage','branches.all')
on conflict do nothing;
insert into public.role_permissions (organization_id,role_id,permission_id)
select '0c300000-0000-4000-8000-000000000002','0c300000-0000-4000-8000-0000000000e2',id
  from public.permissions where key in ('customer.read','customer.manage','branches.all')
on conflict do nothing;
insert into public.role_permissions (organization_id,role_id,permission_id)
select '0c300000-0000-4000-8000-000000000001','0c300000-0000-4000-8000-0000000000e3',id
  from public.permissions where key = 'customer.read'
on conflict do nothing;

insert into public.organization_modules (organization_id,module_id,enabled)
select o.id,m.id,true
  from public.organizations o cross join public.modules m
 where o.id in ('0c300000-0000-4000-8000-000000000001','0c300000-0000-4000-8000-000000000002')
   and m.key = 'crm'
on conflict (organization_id,module_id) do update set enabled = true;

insert into public.subscriptions (organization_id,status) values
  ('0c300000-0000-4000-8000-000000000001','active'),
  ('0c300000-0000-4000-8000-000000000002','active')
on conflict do nothing;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object(
  'sub','c0000000-0000-4000-8000-000000000001',
  'active_org_id','0c300000-0000-4000-8000-000000000001',
  'role','authenticated')::text,true);
do $$
declare v_code text; v_failed boolean := false;
begin
  insert into public.customers (id,organization_id,display_name)
    values ('0c300000-0000-4000-8000-0000000000c1','0c300000-0000-4000-8000-000000000001','A Customer')
    returning customer_code into v_code;
  if v_code <> 'CUST-001' then raise exception 'authorized manager received %', v_code; end if;

  begin
    insert into public.customers (organization_id,display_name,customer_code)
      values ('0c300000-0000-4000-8000-000000000001','Explicit','CUST-999');
  exception when insufficient_privilege then v_failed := true;
  end;
  if not v_failed then raise exception 'authenticated caller supplied customer_code'; end if;
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object(
  'sub','c0000000-0000-4000-8000-000000000003',
  'active_org_id','0c300000-0000-4000-8000-000000000001',
  'role','authenticated')::text,true);
do $$
declare v_count integer; v_failed boolean := false;
begin
  select count(*) into v_count from public.customers
   where organization_id='0c300000-0000-4000-8000-000000000001';
  if v_count <> 1 then raise exception 'reader expected one visible customer, got %', v_count; end if;

  begin
    insert into public.customers (organization_id,display_name)
      values ('0c300000-0000-4000-8000-000000000001','Reader Write');
  exception when insufficient_privilege then v_failed := true;
  end;
  if not v_failed then raise exception 'read-only member inserted customer'; end if;
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object(
  'sub','c0000000-0000-4000-8000-000000000002',
  'active_org_id','0c300000-0000-4000-8000-000000000002',
  'role','authenticated')::text,true);
do $$
declare v_count integer; v_code text; v_failed boolean := false; v_updated integer;
begin
  select count(*) into v_count from public.customers
   where organization_id='0c300000-0000-4000-8000-000000000001';
  if v_count <> 0 then raise exception 'cross-org read leaked % rows', v_count; end if;

  insert into public.customers (organization_id,display_name)
    values ('0c300000-0000-4000-8000-000000000002','B Customer')
    returning customer_code into v_code;
  if v_code <> 'CUST-001' then raise exception 'org B received %', v_code; end if;

  begin
    insert into public.customers (organization_id,display_name)
      values ('0c300000-0000-4000-8000-000000000001','Cross Write');
  exception when insufficient_privilege then v_failed := true;
  end;
  if not v_failed then raise exception 'cross-org insert succeeded'; end if;

  update public.customers
     set status = 'inactive', source = 'cross-org-bulk'
   where id = '0c300000-0000-4000-8000-0000000000c1';
  get diagnostics v_updated = row_count;
  if v_updated <> 0 then raise exception 'cross-org bulk update affected % rows', v_updated; end if;
end $$;
commit;

do $$
begin
  if exists (
    select 1 from public.customers
     where organization_id='0c300000-0000-4000-8000-000000000001'
       and display_name in ('Reader Write','Cross Write')
  ) then
    raise exception 'rejected write changed org A';
  end if;
  if not exists (
    select 1 from public.customers
     where id='0c300000-0000-4000-8000-0000000000c1'
       and organization_id='0c300000-0000-4000-8000-000000000001'
       and status='active'
       and source is null
  ) then
    raise exception 'cross-org bulk update changed A Customer';
  end if;
  raise notice 'CUSTOMER CODE RLS PASS';
end $$;
