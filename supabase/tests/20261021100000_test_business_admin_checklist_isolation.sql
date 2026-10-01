-- TEST — #41 accounts/permissions: the business Admin-permission checklist
-- must be settable and readable ONLY by that business's real owner member —
-- never by an org Admin, and never by the Operro platform owner (even though
-- the platform owner legitimately provisions/invites/bills, per
-- app.is_business_owner vs app.is_business_owner_member in
-- 20261019100000_platform_org_access.sql / 20261020100000_legacy_org_access_roles.sql).
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

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('00000000-0000-0000-0000-000000000000', '0f410000-0000-4000-8000-000000000021', 'authenticated', 'authenticated', 'owner@qc-checklist.test', crypt('x', gen_salt('bf')), now(), '{}', '{}', false, now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '0f410000-0000-4000-8000-000000000022', 'authenticated', 'authenticated', 'admin@qc-checklist.test', crypt('x', gen_salt('bf')), now(), '{}', '{}', false, now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '0f410000-0000-4000-8000-000000000023', 'authenticated', 'authenticated', 'wbudiman1995@gmail.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', false, now(), now(), '', '', '', '')
on conflict (id) do nothing;
update public.users set is_platform_admin = true, status = 'active' where id = '0f410000-0000-4000-8000-000000000023';
update public.users set status = 'active' where id in ('0f410000-0000-4000-8000-000000000021','0f410000-0000-4000-8000-000000000022');

insert into public.memberships (user_id, organization_id, role_id, status) values
  ('0f410000-0000-4000-8000-000000000021', '0f410000-0000-4000-8000-000000000001', '0f410000-0000-4000-8000-000000000011', 'active'),
  ('0f410000-0000-4000-8000-000000000022', '0f410000-0000-4000-8000-000000000001', '0f410000-0000-4000-8000-000000000012', 'active');

do $$
declare v_result jsonb; v_failed boolean;
begin
  -- 1. The real business owner CAN read and set the checklist.
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000021', '0f410000-0000-4000-8000-000000000001');
  perform app.set_business_admin_permissions('0f410000-0000-4000-8000-000000000001', array['booking.read','customer.read']);
  v_result := app.list_organization_access('0f410000-0000-4000-8000-000000000001');
  perform pg_temp.ok((v_result->'admin_keys')::jsonb @> '["booking.read","customer.read"]'::jsonb, 'owner reads the real admin_keys it just set');

  -- 2. An org Admin (not the owner) cannot set or read the real checklist.
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000022', '0f410000-0000-4000-8000-000000000001');
  v_failed := false;
  begin
    perform app.set_business_admin_permissions('0f410000-0000-4000-8000-000000000001', array['booking.read']);
  exception when sqlstate '42501' then v_failed := true;
  end;
  perform pg_temp.ok(v_failed, 'an org Admin cannot call set_business_admin_permissions');
  v_result := app.list_organization_access('0f410000-0000-4000-8000-000000000001');
  perform pg_temp.ok(v_result->'admin_keys' = '[]'::jsonb, 'an org Admin sees redacted (empty) admin_keys, not the real checklist');

  -- 3. The Operro platform owner cannot set or read the real checklist either,
  --    even though they legitimately provision/invite/bill this same org.
  perform pg_temp.act_as('0f410000-0000-4000-8000-000000000023', '0f410000-0000-4000-8000-000000000001');
  perform pg_temp.ok(app.is_operro_owner(), 'sanity: the impersonated user really is the Operro platform owner');
  v_failed := false;
  begin
    perform app.set_business_admin_permissions('0f410000-0000-4000-8000-000000000001', array['booking.read']);
  exception when sqlstate '42501' then v_failed := true;
  end;
  perform pg_temp.ok(v_failed, 'the Operro platform owner cannot call set_business_admin_permissions');
  v_result := app.list_organization_access('0f410000-0000-4000-8000-000000000001');
  perform pg_temp.ok(v_result->'admin_keys' = '[]'::jsonb, 'the Operro platform owner sees redacted (empty) admin_keys, never the real checklist');
  perform pg_temp.ok(jsonb_array_length(v_result->'members') = 2, 'the platform owner still sees the member list (legitimate provisioning use), just not the checklist');
end $$;

rollback;
