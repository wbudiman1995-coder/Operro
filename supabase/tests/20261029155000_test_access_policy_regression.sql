-- E3.2 Permanent access-policy regression suite (parity #41). Real PostgreSQL roles and RLS; no UI involved.
--   1. The Operro platform owner can enter a SUSPENDED workspace and inspect/change its tenant-Admin checklist.
--   2. A tenant Admin (and the suspended business's own owner) cannot manage that checklist.
--   3. "Bantuan Operro" is denied payroll, finance reporting and access management, in RLS and in RPCs.
--   4. The platform-owner superuser policy (JWT app_metadata.is_platform_admin) is unchanged.
--   5. Cross-tenant and revoked/suspended states deny immediately, even on a stale token.
-- Uses only synthetic users in a rolled-back transaction: no real invitation, account or e-mail is created.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029155000_test_access_policy_regression.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.claims(p_user uuid, p_org uuid, p_platform boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'active_org_id', p_org,
    'app_metadata', json_build_object('is_platform_admin', p_platform))::text, true);
end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin if p_cond is true then raise notice 'PASS: %', p_label; else raise exception 'FAIL: %', p_label; end if; end $$;

begin;

-- ---- identities (synthetic) ------------------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('e3200000-0000-4000-8000-000000000001', 'wbudiman1995@gmail.com', '{}'),    -- the Operro platform owner
  ('e3200000-0000-4000-8000-000000000002', 'owner-a@e32.test', '{}'),           -- business owner A
  ('e3200000-0000-4000-8000-000000000003', 'admin-a@e32.test', '{}'),           -- tenant Admin A
  ('e3200000-0000-4000-8000-000000000004', 'support-a@e32.test', '{}'),         -- Bantuan Operro in A
  ('e3200000-0000-4000-8000-000000000005', 'owner-s@e32.test', '{}'),           -- business owner of the suspended workspace
  ('e3200000-0000-4000-8000-000000000006', 'admin-s@e32.test', '{}'),           -- tenant Admin of the suspended workspace
  ('e3200000-0000-4000-8000-000000000007', 'owner-b@e32.test', '{}'),           -- business owner B (other tenant)
  ('e3200000-0000-4000-8000-000000000008', 'groomer-a@e32.test', '{}');
update public.users set status = 'active' where id::text like 'e3200000-%';
update public.users set is_platform_admin = true where id = 'e3200000-0000-4000-8000-000000000001';

-- ---- workspaces provisioned through the real platform path -----------------------------------------------------
select pg_temp.claims('e3200000-0000-4000-8000-000000000001', null, true);
do $$
declare v_a uuid; v_s uuid; v_b uuid; v_branch uuid; v_role uuid;
begin
  v_a := app.prepare_operro_organization('E32 Alpha', 'e32-alpha');
  v_s := app.prepare_operro_organization('E32 Suspended', 'e32-suspended');
  v_b := app.prepare_operro_organization('E32 Beta', 'e32-beta');
  update public.organizations set status = 'active' where id in (v_a, v_s, v_b);
  perform set_config('e32.a', v_a::text, true); perform set_config('e32.s', v_s::text, true); perform set_config('e32.b', v_b::text, true);

  insert into public.memberships (user_id, organization_id, role_id, status)
  select u.id, o.org, r.id, 'active'
  from (values ('e3200000-0000-4000-8000-000000000002'::uuid, v_a, 'Pemilik'), ('e3200000-0000-4000-8000-000000000003'::uuid, v_a, 'Admin'),
               ('e3200000-0000-4000-8000-000000000004'::uuid, v_a, 'Bantuan Operro'), ('e3200000-0000-4000-8000-000000000008'::uuid, v_a, 'Groomer'),
               ('e3200000-0000-4000-8000-000000000005'::uuid, v_s, 'Pemilik'), ('e3200000-0000-4000-8000-000000000006'::uuid, v_s, 'Admin'),
               ('e3200000-0000-4000-8000-000000000007'::uuid, v_b, 'Pemilik')) as o(uid, org, rname)
  join public.users u on u.id = o.uid
  join public.roles r on r.organization_id = o.org and r.name = o.rname;

  -- Admin gets an explicit owner-chosen checklist, so a later checklist change is observable.
  perform app.set_business_admin_permissions(v_a, array['booking.read', 'customer.read']);

  -- Tenant data for payroll and finance in every workspace.
  for v_branch, v_role in select b.id, o.id from public.branches b join public.organizations o on o.id = b.organization_id where o.id in (v_a, v_s, v_b) loop
    insert into public.payroll_runs (organization_id, branch_id, period_start, period_end, status, currency, total_gross, total_net)
      values (v_role, v_branch, '2026-09-01', '2026-09-30', 'draft', 'IDR', 1, 1);
    insert into public.customers (organization_id, display_name) values (v_role, 'Cust ' || left(v_role::text, 4));
    insert into public.invoices (organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total)
      select v_role, v_branch, c.id, 'E32-' || left(v_role::text, 4), 'issued', 'IDR', 100, 100 from public.customers c where c.organization_id = v_role;
    insert into public.payments (organization_id, branch_id, invoice_id, method, amount, currency, status)
      select v_role, v_branch, i.id, 'cash', 100, 'IDR', 'succeeded' from public.invoices i where i.organization_id = v_role;
  end loop;
  -- Suspend the workspace through the owner-only RPC.
  perform app.set_operro_organization_status(v_s, 'suspended', 'E32 regression');
end $$;

grant select on all tables in schema public to authenticated;   -- GATE bare-PG16 lacks Supabase default grants; RLS still decides
set local role authenticated;

-- =====================================================================
-- 1. Platform owner: suspended workspace + tenant Admin checklist
-- =====================================================================
select pg_temp.claims('e3200000-0000-4000-8000-000000000001', current_setting('e32.s')::uuid, true);
do $$
declare s uuid := current_setting('e32.s')::uuid; r jsonb;
begin
  perform pg_temp.ok(app.is_operro_owner(), 'sanity: this identity is the Operro platform owner');
  perform pg_temp.ok(public.set_active_organization(s) = s, 'platform owner can switch into the suspended workspace');
  perform pg_temp.ok(app.has_membership() and app.has_permission('payroll.read'), 'platform-owner superuser policy: membership and permissions in the suspended workspace');
  perform pg_temp.ok((select count(*) from public.payroll_runs where organization_id = s) = 1, 'platform owner reads the suspended workspace''s payroll rows through RLS');
  perform pg_temp.ok((select count(*) from public.payments where organization_id = s) = 1, 'platform owner reads the suspended workspace''s finance rows through RLS');
  perform app.set_business_admin_permissions(s, array['booking.read', 'customer.read', 'finance.read']);
  r := app.list_organization_access(s);
  perform pg_temp.ok(r -> 'admin_keys' @> '["finance.read"]'::jsonb and jsonb_array_length(r -> 'members') >= 3, 'platform owner reads and changes the suspended workspace''s Admin checklist and member list');
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['roles.manage'])$q$, s), '22023', 'the checklist can never carry access-management permissions, even for the platform owner');
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['no.such.permission'])$q$, s), '22023', 'unknown permission keys are rejected');
end $$;

-- Token refresh keeps the suspended workspace for the platform owner only.
reset role;
do $$
declare v jsonb;
begin
  v := public.custom_access_token_hook(jsonb_build_object('user_id', 'e3200000-0000-4000-8000-000000000001', 'claims', jsonb_build_object('sub', 'e3200000-0000-4000-8000-000000000001', 'app_metadata', '{}'::jsonb)));
  perform pg_temp.ok(v #> '{claims,app_metadata,is_platform_admin}' = 'true'::jsonb, 'token hook stamps the platform flag from the profile, not from the request');
  update public.users set active_organization_id = current_setting('e32.s')::uuid where id = 'e3200000-0000-4000-8000-000000000001';
  v := public.custom_access_token_hook(jsonb_build_object('user_id', 'e3200000-0000-4000-8000-000000000001', 'claims', jsonb_build_object('sub', 'e3200000-0000-4000-8000-000000000001', 'app_metadata', '{}'::jsonb)));
  perform pg_temp.ok(v #>> '{claims,active_org_id}' = current_setting('e32.s'), 'platform owner keeps the suspended workspace after token refresh');
  v := public.custom_access_token_hook(jsonb_build_object('user_id', 'e3200000-0000-4000-8000-000000000005', 'claims', jsonb_build_object('sub', 'e3200000-0000-4000-8000-000000000005', 'app_metadata', '{}'::jsonb)));
  perform pg_temp.ok(v #>> '{claims,active_org_id}' is null, 'the suspended business''s own owner does NOT keep it after token refresh');
  -- The flag cannot be forged from a request: a non-owner profile never gets it.
  v := public.custom_access_token_hook(jsonb_build_object('user_id', 'e3200000-0000-4000-8000-000000000003', 'claims', jsonb_build_object('sub', 'e3200000-0000-4000-8000-000000000003', 'app_metadata', jsonb_build_object('is_platform_admin', true))));
  perform pg_temp.ok(v #> '{claims,app_metadata,is_platform_admin}' = 'false'::jsonb, 'a forged is_platform_admin claim is overwritten by the profile value');
end $$;
set local role authenticated;

-- =====================================================================
-- 2. Tenant Admin / suspended business owner cannot manage the checklist
-- =====================================================================
select pg_temp.claims('e3200000-0000-4000-8000-000000000003', current_setting('e32.a')::uuid);
do $$
declare a uuid := current_setting('e32.a')::uuid;
begin
  perform pg_temp.ok(app.has_permission('booking.read') and not app.has_permission('payroll.read') and not app.has_permission('roles.manage'), 'Admin holds exactly the owner-chosen checklist');
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['payroll.read'])$q$, a), '42501', 'tenant Admin cannot change the checklist');
  perform pg_temp.expect(format($q$select app.list_organization_access(%L)$q$, a), '42501', 'tenant Admin cannot read the access payload');
  perform pg_temp.expect(format($q$select app.set_organization_member_role(%L, 'owner-a@e32.test', 'Groomer', 'active')$q$, a), '42501', 'tenant Admin cannot demote the owner');
  perform pg_temp.expect(format($q$select app.set_organization_member_role(%L, 'admin-a@e32.test', 'Pemilik', 'active')$q$, a), '42501', 'tenant Admin cannot promote themselves to owner');
  perform pg_temp.expect(format($q$select app.issue_access_invitation(%L, 'x@e32.test', 'Admin')$q$, a), '42501', 'tenant Admin cannot issue invitations');
  perform pg_temp.expect($q$update public.role_permissions set permission_id = permission_id$q$, '42501', 'direct role_permissions writes are revoked');
  perform pg_temp.expect($q$insert into public.memberships (user_id, organization_id, role_id) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())$q$, '42501', 'direct membership writes are revoked');
  perform pg_temp.expect($q$update public.organizations set status = 'active'$q$, '42501', 'direct organization status writes are revoked');
  perform pg_temp.expect(format($q$select app.set_operro_organization_status(%L, 'suspended', 'x')$q$, a), '42501', 'tenant Admin cannot suspend a workspace');
end $$;
-- Suspended workspace: its Admin and its own owner (stale token) are locked out of the checklist and tenant data.
select pg_temp.claims('e3200000-0000-4000-8000-000000000006', current_setting('e32.s')::uuid);
do $$
declare s uuid := current_setting('e32.s')::uuid;
begin
  perform pg_temp.ok(not app.has_membership() and not app.has_permission('booking.read'), 'suspended workspace: stale Admin token carries no authority');
  perform pg_temp.ok((select count(*) from public.customers where organization_id = s) = 0, 'suspended workspace: stale Admin token reads no tenant rows');
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['booking.read'])$q$, s), '42501', 'suspended workspace: Admin cannot change the checklist');
end $$;
select pg_temp.claims('e3200000-0000-4000-8000-000000000005', current_setting('e32.s')::uuid);
do $$
declare s uuid := current_setting('e32.s')::uuid;
begin
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['booking.read'])$q$, s), '42501', 'suspended workspace: even its own owner cannot change the checklist (platform owner only)');
  perform pg_temp.expect(format($q$select app.list_organization_access(%L)$q$, s), '42501', 'suspended workspace: its owner cannot read the access payload');
  perform pg_temp.expect(format($q$select public.set_active_organization(%L)$q$, s), '42501', 'suspended workspace: its owner cannot switch into it');
end $$;

-- An active business owner CAN manage their own checklist, but not another tenant's.
select pg_temp.claims('e3200000-0000-4000-8000-000000000002', current_setting('e32.a')::uuid);
do $$
declare a uuid := current_setting('e32.a')::uuid; b uuid := current_setting('e32.b')::uuid;
begin
  perform app.set_business_admin_permissions(a, array['booking.read', 'customer.read', 'customer.manage']);
  perform pg_temp.ok(app.list_organization_access(a) -> 'admin_keys' @> '["customer.manage"]'::jsonb, 'active business owner manages their own checklist');
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['booking.read'])$q$, b), '42501', 'business owner A cannot change business B''s checklist');
  perform pg_temp.expect(format($q$select app.list_organization_access(%L)$q$, b), '42501', 'business owner A cannot read business B''s access payload');
  perform pg_temp.ok((select count(*) from public.payroll_runs where organization_id = b) = 0, 'business owner A reads none of business B''s payroll rows');
end $$;

-- =====================================================================
-- 3. Bantuan Operro: no payroll, no finance reporting, no access management
-- =====================================================================
select pg_temp.claims('e3200000-0000-4000-8000-000000000004', current_setting('e32.a')::uuid);
do $$
declare a uuid := current_setting('e32.a')::uuid; k text;
begin
  perform pg_temp.ok(app.has_membership() and app.has_permission('booking.read') and app.has_permission('customer.manage'), 'sanity: the helper keeps normal operational capabilities');
  foreach k in array array['payroll.read', 'payroll.manage', 'payroll.approve', 'finance.read', 'reports.view', 'roles.manage', 'users.manage'] loop
    perform pg_temp.ok(not app.has_permission(k), 'Bantuan Operro lacks ' || k);
  end loop;
  -- RLS: capability denial is what hides the rows (the helper does hold branch access).
  perform pg_temp.ok((select count(*) from public.payroll_runs) = 0, 'payroll_runs hidden by RLS');
  perform pg_temp.ok((select count(*) from public.payroll_items) = 0, 'payroll_items hidden by RLS');
  perform pg_temp.ok((select count(*) from public.invoices) = 0 and (select count(*) from public.payments) = 0 and (select count(*) from public.refunds) = 0 and (select count(*) from public.expenses) = 0, 'finance tables hidden by RLS');
  perform pg_temp.ok((select count(*) from public.customers) = 1, 'sanity: the helper still reads customers of its own workspace');
  -- RPCs
  perform pg_temp.expect(format($q$select * from app.payroll_export_detail_rows(%L, '2026-09-01', '2026-09-30')$q$, a), '42501', 'payroll export RPC denied');
  perform pg_temp.expect($q$select app.recompute_payroll_run('2026-09-01', '2026-09-30')$q$, '42501', 'payroll recompute RPC denied');
  perform pg_temp.expect($q$select * from app.finance_cash_position('2026-09-01', '2026-09-30')$q$, '42501', 'finance cash position denied');
  perform pg_temp.expect($q$select * from app.reconcile_invoice_payments(null, null, 5)$q$, '42501', 'invoice/payment reconciliation denied');
  perform pg_temp.expect($q$select * from app.reconcile_payroll_sources(null, 5)$q$, '42501', 'payroll reconciliation denied');
  perform pg_temp.expect($q$select * from app.search_audit_events(null, null, null, null, null, null, null, 5)$q$, '42501', 'audit viewer denied (reports.view)');
  perform pg_temp.ok(not exists (select 1 from app.search_payment_register(null, null, null, null, null, 5)), 'payment register returns no rows');
  perform pg_temp.expect(format($q$select app.list_organization_access(%L)$q$, a), '42501', 'access payload denied');
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['payroll.read'])$q$, a), '42501', 'checklist denied');
  perform pg_temp.expect(format($q$select app.set_organization_member_role(%L, 'support-a@e32.test', 'Pemilik', 'active')$q$, a), '42501', 'role management denied (no self-promotion)');
  perform pg_temp.expect(format($q$select app.issue_access_invitation(%L, 'x@e32.test', 'Admin')$q$, a), '42501', 'invitations denied');
  perform pg_temp.expect($q$delete from public.role_permissions$q$, '42501', 'direct permission edits denied');
end $$;

-- =====================================================================
-- 4. Platform-owner superuser policy is exactly the JWT claim, nothing else
-- =====================================================================
select pg_temp.claims('e3200000-0000-4000-8000-000000000003', current_setting('e32.b')::uuid, true);
do $$ begin
  perform pg_temp.ok(app.is_platform_admin() and app.has_permission('payroll.read') and app.has_membership(), 'superuser policy: the server-stamped claim grants authority anywhere');
end $$;
select pg_temp.claims('e3200000-0000-4000-8000-000000000003', current_setting('e32.b')::uuid, false);
do $$ begin
  perform pg_temp.ok(not app.is_platform_admin() and not app.has_permission('payroll.read') and not app.has_membership(), 'without the claim the same user has nothing in a foreign workspace');
  perform pg_temp.ok((select count(*) from public.payroll_runs) = 0 and (select count(*) from public.customers) = 0, 'and sees no foreign rows');
end $$;

-- =====================================================================
-- 5. Revoked / suspended states take effect immediately
-- =====================================================================
reset role;
update public.memberships set status = 'suspended' where user_id = 'e3200000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.claims('e3200000-0000-4000-8000-000000000003', current_setting('e32.a')::uuid);
do $$ begin
  perform pg_temp.ok(not app.has_membership() and not app.has_permission('booking.read') and (select count(*) from public.customers) = 0, 'suspended membership: stale token denied');
end $$;
reset role;
update public.memberships set status = 'active' where user_id = 'e3200000-0000-4000-8000-000000000003';
update public.users set status = 'deactivated' where id = 'e3200000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.claims('e3200000-0000-4000-8000-000000000003', current_setting('e32.a')::uuid);
do $$ begin
  perform pg_temp.ok(not app.has_membership() and not app.has_permission('booking.read'), 'deactivated user profile: stale token denied');
end $$;
reset role;
update public.users set status = 'active' where id = 'e3200000-0000-4000-8000-000000000003';
delete from public.role_permissions where organization_id = current_setting('e32.a')::uuid
  and role_id = (select id from public.roles where organization_id = current_setting('e32.a')::uuid and name = 'Admin')
  and permission_id = (select id from public.permissions where key = 'booking.read');
set local role authenticated;
select pg_temp.claims('e3200000-0000-4000-8000-000000000003', current_setting('e32.a')::uuid);
do $$ begin
  perform pg_temp.ok(not app.has_permission('booking.read') and app.has_permission('customer.read'), 'revoked capability: only that capability is lost, immediately');
end $$;
reset role;
update public.organizations set status = 'suspended' where id = current_setting('e32.a')::uuid;
set local role authenticated;
select pg_temp.claims('e3200000-0000-4000-8000-000000000002', current_setting('e32.a')::uuid);
do $$
declare a uuid := current_setting('e32.a')::uuid;
begin
  perform pg_temp.ok(not app.has_membership() and (select count(*) from public.customers) = 0, 'workspace suspended while a token is live: its owner loses tenant access at once');
  perform pg_temp.expect(format($q$select app.set_business_admin_permissions(%L, array['booking.read'])$q$, a), '42501', 'workspace suspended while a token is live: its owner loses checklist control at once');
end $$;
select pg_temp.claims('e3200000-0000-4000-8000-000000000001', current_setting('e32.a')::uuid, true);
do $$
declare a uuid := current_setting('e32.a')::uuid;
begin
  perform app.set_business_admin_permissions(a, array['booking.read']);
  perform pg_temp.ok(app.list_organization_access(a) -> 'admin_keys' = '["booking.read"]'::jsonb, 'platform owner still controls the checklist of the newly suspended workspace');
end $$;

-- Grants: nothing here is reachable by anon or PUBLIC.
reset role;
do $$ begin
  if has_function_privilege('anon', 'app.set_business_admin_permissions(uuid,text[])', 'execute')
     or has_function_privilege('anon', 'app.list_organization_access(uuid)', 'execute')
     or has_function_privilege('anon', 'app.set_organization_member_role(uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'app.set_operro_organization_status(uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'app.issue_access_invitation(uuid,text,text)', 'execute')
     or has_function_privilege('public', 'app.prepare_operro_organization(text,text)', 'execute') then
    raise exception 'FAIL anon/public reach access-management functions'; end if;
  raise notice 'PASS: access-management functions are not callable by anon or PUBLIC';
end $$;
rollback;
