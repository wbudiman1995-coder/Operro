-- =====================================================================
-- Batch 2 INTEGRATION test — assembly operations through the REAL
-- authenticated role (Supabase-equivalent authenticator -> authenticated).
-- =====================================================================
-- Run: apply 0001..0013 + batch2/0100 as owner, seed as owner (SEED section
-- below, run as postgres/service), then run the CLIENT section AS the
-- authenticator login role (SET ROLE authenticated). Mirrors how PostgREST
-- executes RPCs on Supabase. Proves the assembly RPCs authorize + mutate under
-- the real role with RLS active — the app never touches tables directly.
--
-- This file is split by a marker so the runner can execute each half with the
-- right identity. See STAGING_SUPABASE_RUNBOOK.md Step 3.
-- =====================================================================

-- ========================= SEED (run as postgres/service) =========================
-- \i only the section you need; the harness below runs them with the right role.
-- Idempotent-ish: assumes a fresh DB.

-- (seed)
insert into public.organizations (id,name,slug,status) values
  ('0e000000-0000-4000-8000-000000000001','B2 Int Org','b2-int','active') on conflict do nothing;
insert into public.branches (id,organization_id,name,is_default,status) values
  ('0e000000-0000-4000-8000-0000000000a1','0e000000-0000-4000-8000-000000000001','Main',true,'active') on conflict do nothing;
insert into auth.users (id) values ('0e000000-0000-4000-8000-0000000000c1') on conflict do nothing;
insert into public.users (id,full_name,email,status) values
  ('0e000000-0000-4000-8000-0000000000c1','Int User','i@b2.test','active') on conflict do nothing;
insert into public.roles (id,organization_id,name,is_system) values
  ('0e000000-0000-4000-8000-0000000000e1','0e000000-0000-4000-8000-000000000001','Owner',true) on conflict do nothing;
insert into public.memberships (id,organization_id,user_id,role_id,status) values
  ('0e000000-0000-4000-8000-0000000000d1','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000c1','0e000000-0000-4000-8000-0000000000e1','active') on conflict do nothing;
insert into public.membership_branch_access (organization_id,membership_id,branch_id) values
  ('0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000d1','0e000000-0000-4000-8000-0000000000a1') on conflict do nothing;
insert into public.permissions (id,key,resource,action,description) values
  ('0e000000-0000-4000-8000-0000000000f2','booking.read','booking','read','r'),
  ('0e000000-0000-4000-8000-0000000000f3','booking.update','booking','update','u'),
  ('0e000000-0000-4000-8000-0000000000f5','membership.read','membership','read','m')
  on conflict (key) do nothing;
insert into public.role_permissions (organization_id,role_id,permission_id)
  select '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000e1',p.id
  from public.permissions p where p.key in ('booking.read','booking.update','membership.read') on conflict do nothing;
insert into public.organization_modules (organization_id,module_id,enabled)
  select '0e000000-0000-4000-8000-000000000001',m.id,true from public.modules m where m.key in ('scheduling','membership')
  on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions (organization_id,status) values ('0e000000-0000-4000-8000-000000000001','active') on conflict do nothing;
insert into public.customers (id,organization_id,display_name) values ('0e000000-0000-4000-8000-0000000000f0','0e000000-0000-4000-8000-000000000001','Cust') on conflict do nothing;
insert into public.pets (id,organization_id,customer_id,name) values
  ('0e000000-0000-4000-8000-0000000000f1','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000f0','PetA') on conflict do nothing;
insert into public.service_catalog (id,organization_id,name,base_price,currency) values
  ('0e000000-0000-4000-8000-000000005001','0e000000-0000-4000-8000-000000000001','Bath',100,'USD') on conflict do nothing;
insert into public.bookings (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at) values
  ('0e000000-0000-4000-8000-00000000ba01','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000a1','0e000000-0000-4000-8000-0000000000f0','grooming','confirmed',now(),now()+interval '2h') on conflict do nothing;

-- ========================= CLIENT (run as authenticated) =========================
-- The following block is what the harness runs while connected as the
-- authenticator login role. It performs the whole assembly round-trip via RPCs.

-- Extra fixtures for correction-pass integration coverage:
insert into public.customers (id,organization_id,display_name) values
  ('0e000000-0000-4000-8000-00000000c102','0e000000-0000-4000-8000-000000000001','OtherCust') on conflict do nothing;
insert into public.pets (id,organization_id,customer_id,name) values
  ('0e000000-0000-4000-8000-0000000000f2','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-00000000c102','OtherPet') on conflict do nothing;
insert into public.resources (id,organization_id,branch_id,kind,name,capacity,status,membership_id) values
  ('0e000000-0000-4000-8000-0000000e5001','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000a1','staff','Groomer',1,'active','0e000000-0000-4000-8000-0000000000d1') on conflict do nothing;

-- Package + customer-package fixtures for the authenticated reservation test
-- (item 1). Package is Bath-specific, belongs to the booking's customer (f0),
-- three sessions available.
insert into public.packages (id,organization_id,name,service_id,total_sessions,price,currency) values
  ('0e000000-0000-4000-8000-00000000a001','0e000000-0000-4000-8000-000000000001','Bath3','0e000000-0000-4000-8000-000000005001',3,240,'USD') on conflict do nothing;
insert into public.customer_packages (id,organization_id,customer_id,package_id,service_id,status) values
  ('0e000000-0000-4000-8000-0000000ca001','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000f0','0e000000-0000-4000-8000-00000000a001','0e000000-0000-4000-8000-000000005001','active') on conflict do nothing;
insert into public.customer_package_ledger (organization_id,customer_package_id,delta,reason) values
  ('0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000ca001',3,'purchase') on conflict do nothing;
-- ResPet for the authenticated reservation test (owned by booking customer f0).
insert into public.pets (id,organization_id,customer_id,name) values
  ('0e000000-0000-4000-8000-0000000000f9','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000f0','ResPet') on conflict do nothing;
