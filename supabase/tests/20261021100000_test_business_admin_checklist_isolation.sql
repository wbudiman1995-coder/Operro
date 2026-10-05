-- TEST — #41 accounts/permissions: the business Admin-permission checklist
-- is settable/readable by that business's real owner and by the Operro
-- platform owner, but never by a tenant Admin. The platform-owner rule is
-- authoritative in 20261022100000_platform_owner_workspace_access.sql.
-- This verifies the SERVER-SIDE RPC checks, not UI button visibility.
-- Run: apply the full migration lineage, then
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, label text)
returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %', label; else raise exception 'FAIL: %', label; end if; end $$;
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'active_org_id', o)::text, true); end $$;

begin;

insert into public.organizations (id, name, slug, status) values
  ('0f410000-0000-4000-8000-000000000001', 'QC Checklist Org', 'qc-checklist-org', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end) values
  ('0f410000-0000-4000-8000-000000000001', 'active', now() - interval '1 day', now() + interval '1 year');
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select '0f410000-0000-4000-8000-000000000001', id, true, 'override' from public.modules;

insert into public.roles (id, organization_id, name, is_system) values
  ('0f410000-0000-4000-8000-000000000011', '0f410000-0000-4000-8000-000000000001', 'Pemilik', true),
  ('0f410000-0000-4000-8000-000000000012', '0f410000-0000-4000-8000-000000000001', 'Admin', true);
insert into public.role_permissions (organization_id, role_id, permission_id)
  select '0f410000-0000-4000-8000-000000000001', '0f410000-0000-4000-8000-000000000011', id from public.permissions;

insert into auth.users (id, email, raw_user_meta_data)
values
  ('0f410000-0000-4000-8000-000000000021', 'owner@qc-checklist.test', '{}'),
  ('0f410000-0000-4000-8000-000000000022', 'admin@qc-checklist.test', '{}'),
  ('0f410000-0000-4000-8000-000000000023', 'wbudiman1995@gmail.com', '{}'),
  ('0f410000-0000-4000-8000-000000000024', 'support@qc-checklist.test', '{}')
on conflict (id) do nothing;
update public.users set is_platform_admin = true, status = 'active' where id = '0f410000-0000-4000-8000-000000000023';
update public.users set status = 'active' where id in ('0f410000-0000-4000-8000-000000000021','0f410000-0000-4000-8000-000000000022','0f410000-0000-4000-8000-000000000024');

insert into public.memberships (user_id, organization_id, role_id, status) values
  ('0f410000-0000-4000-8000-000000000021', '0f410000-0000-4000-8000-000000000001', '0f410000-0000-4000-8000-000000000011', 'active'),
  ('0f410000-0000-4000-8000-000000000022', '0f410000-0000-4000-8000-000000000001', '0f410000-0000-4000-8000-000000000012', 'active');

do $$
declare v_org uuid; v_role uuid; v_branch uuid;
begin
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000023', '0f410000-0000-4000-8000-000000000001');
  v_org := app.prepare_operro_organization('Support QC Org', 'support-qc-org');
  select id into v_role from public.roles where organization_id=v_org and name='Bantuan Operro';
  select id into v_branch from public.branches where organization_id=v_org and is_default;
  insert into public.memberships(user_id,organization_id,role_id,status)
    values ('0f410000-0000-4000-8000-000000000024',v_org,v_role,'active');
  insert into public.payroll_runs(organization_id,branch_id,period_start,period_end,status,currency,total_gross,total_net)
    values (v_org,v_branch,'2026-09-01','2026-09-30','draft','IDR',100000,90000);
  perform set_config('operro_test.support_org',v_org::text,true);
end $$;

set local role authenticated;

do $$
declare v_result jsonb; v_failed boolean; v_support_org uuid; v_count integer;
begin
  -- 1. The real business owner CAN read and set the checklist.
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000021', '0f410000-0000-4000-8000-000000000001');
  perform app.set_business_admin_permissions('0f410000-0000-4000-8000-000000000001', array['booking.read','customer.read']);
  v_result := app.list_organization_access('0f410000-0000-4000-8000-000000000001');
  perform pg_temp.ok((v_result->'admin_keys')::jsonb @> '["booking.read","customer.read"]'::jsonb, 'owner reads the real admin_keys it just set');

  -- 2. An org Admin (not the owner) cannot set or read the access payload.
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000022', '0f410000-0000-4000-8000-000000000001');
  v_failed := false;
  begin
    perform app.set_business_admin_permissions('0f410000-0000-4000-8000-000000000001', array['booking.read']);
  exception when sqlstate '42501' then v_failed := true;
  end;
  perform pg_temp.ok(v_failed, 'an org Admin cannot call set_business_admin_permissions');
  v_failed := false;
  begin
    v_result := app.list_organization_access('0f410000-0000-4000-8000-000000000001');
  exception when sqlstate '42501' then v_failed := true;
  end;
  perform pg_temp.ok(v_failed, 'an org Admin cannot read list_organization_access');

  -- 3. The Operro platform owner CAN inspect and repair the checklist.
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000023', '0f410000-0000-4000-8000-000000000001');
  perform pg_temp.ok(app.is_operro_owner(), 'sanity: the impersonated user really is the Operro platform owner');
  perform app.set_business_admin_permissions('0f410000-0000-4000-8000-000000000001', array['booking.read']);
  v_result := app.list_organization_access('0f410000-0000-4000-8000-000000000001');
  perform pg_temp.ok(v_result->'admin_keys' = '["booking.read"]'::jsonb, 'the Operro platform owner can set and read the real checklist');
  perform pg_temp.ok(jsonb_array_length(v_result->'members') = 2, 'the platform owner also sees the member list for provisioning');

  -- 4. The provisioned support role has neither payroll capability nor RLS visibility.
  v_support_org := current_setting('operro_test.support_org')::uuid;
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000024', v_support_org::text);
  perform pg_temp.ok(not app.has_permission('payroll.read'), 'Bantuan Operro has no payroll.read capability');
  perform pg_temp.ok(not app.has_permission('finance.read'), 'Bantuan Operro has no finance.read capability');
  select count(*) into v_count from public.payroll_runs where organization_id=v_support_org;
  perform pg_temp.ok(v_count=0, 'payroll RLS hides tenant payroll rows from Bantuan Operro');
end $$;

rollback;
