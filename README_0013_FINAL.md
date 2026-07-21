-- T11 concurrency setup: package with EXACTLY ONE session, two distinct lines.
\set ON_ERROR_STOP on
begin;
insert into public.organizations (id,name,slug,status) values ('0c000000-0000-4000-8000-000000000001','Conc','conc','active') on conflict do nothing;
insert into public.branches (id,organization_id,name,is_default,status) values ('0c000000-0000-4000-8000-0000000000b1','0c000000-0000-4000-8000-000000000001','Main',true,'active') on conflict do nothing;
insert into auth.users (id) values ('0c000000-0000-4000-8000-000000000c01') on conflict do nothing;
insert into public.users (id,full_name,email,status) values ('0c000000-0000-4000-8000-000000000c01','C','c@t.test','active') on conflict do nothing;
insert into public.roles (id,organization_id,name,is_system) values ('0c000000-0000-4000-8000-00000000e001','0c000000-0000-4000-8000-000000000001','Owner',true) on conflict do nothing;
insert into public.memberships (id,organization_id,user_id,role_id,status) values ('0c000000-0000-4000-8000-00000000d001','0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-000000000c01','0c000000-0000-4000-8000-00000000e001','active') on conflict do nothing;
insert into public.membership_branch_access (organization_id,membership_id,branch_id) values ('0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-00000000d001','0c000000-0000-4000-8000-0000000000b1') on conflict do nothing;
insert into public.role_permissions (organization_id,role_id,permission_id)
  select '0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-00000000e001',p.id from public.permissions p where p.key in ('booking.read','booking.update','booking.complete') on conflict do nothing;
insert into public.organization_modules (organization_id,module_id,enabled)
  select '0c000000-0000-4000-8000-000000000001',m.id,true from public.modules m where m.key in ('scheduling','membership')
  on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions (organization_id,status) values ('0c000000-0000-4000-8000-000000000001','active') on conflict do nothing;
insert into public.customers (id,organization_id,display_name) values ('0c000000-0000-4000-8000-00000000c0f1','0c000000-0000-4000-8000-000000000001','C1') on conflict do nothing;
insert into public.pets (id,organization_id,customer_id,name) values ('0c000000-0000-4000-8000-00000000f001','0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-00000000c0f1','Rex') on conflict do nothing;
insert into public.service_catalog (id,organization_id,name,base_price,currency) values ('0c000000-0000-4000-8000-000000005001','0c000000-0000-4000-8000-000000000001','Bath',100,'USD') on conflict do nothing;
insert into public.bookings (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at) values ('0c000000-0000-4000-8000-0000000b0001','0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-0000000000b1','0c000000-0000-4000-8000-00000000c0f1','grooming','confirmed',now(),now()+interval '2 hours') on conflict do nothing;
insert into public.grooming_jobs (booking_id,organization_id) values ('0c000000-0000-4000-8000-0000000b0001','0c000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.grooming_job_pets (id,organization_id,grooming_job_id,pet_id) values ('0c000000-0000-4000-8000-00000009f001','0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-0000000b0001','0c000000-0000-4000-8000-00000000f001') on conflict do nothing;
insert into public.grooming_job_pet_services (id,organization_id,grooming_job_pet_id,service_id,service_name_snapshot,unit_price_snapshot,currency) values
  ('0c000000-0000-4000-8000-0000000f1001','0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-00000009f001','0c000000-0000-4000-8000-000000005001','Bath',100,'USD'),
  ('0c000000-0000-4000-8000-0000000f1002','0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-00000009f001','0c000000-0000-4000-8000-000000005001','Bath',100,'USD') on conflict do nothing;
insert into public.packages (id,organization_id,name,service_id,total_sessions,price,currency) values ('0c000000-0000-4000-8000-0000000a0001','0c000000-0000-4000-8000-000000000001','Single','0c000000-0000-4000-8000-000000005001',1,80,'USD') on conflict do nothing;
insert into public.customer_packages (id,organization_id,customer_id,package_id,service_id,status) values ('0c000000-0000-4000-8000-0000000ca001','0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-00000000c0f1','0c000000-0000-4000-8000-0000000a0001','0c000000-0000-4000-8000-000000005001','active') on conflict do nothing;
insert into public.customer_package_ledger (organization_id,customer_package_id,delta,reason) values ('0c000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-0000000ca001',1,'purchase');
commit;
