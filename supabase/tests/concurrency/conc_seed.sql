\set ON_ERROR_STOP on
insert into public.organizations (id,name,slug,status) values ('0c100000-0000-4000-8000-000000000001','Cc','cc','active') on conflict do nothing;
insert into public.branches (id,organization_id,name,is_default,status) values ('0c100000-0000-4000-8000-0000000000a1','0c100000-0000-4000-8000-000000000001','M',true,'active') on conflict do nothing;
insert into auth.users (id) values ('0c100000-0000-4000-8000-0000000000c1') on conflict do nothing;
insert into public.users (id,full_name,email,status) values ('0c100000-0000-4000-8000-0000000000c1','U','u@cc.test','active') on conflict do nothing;
insert into public.roles (id,organization_id,name,is_system) values ('0c100000-0000-4000-8000-0000000000e1','0c100000-0000-4000-8000-000000000001','Owner',true) on conflict do nothing;
insert into public.memberships (id,organization_id,user_id,role_id,status) values ('0c100000-0000-4000-8000-0000000000d1','0c100000-0000-4000-8000-000000000001','0c100000-0000-4000-8000-0000000000c1','0c100000-0000-4000-8000-0000000000e1','active') on conflict do nothing;
insert into public.membership_branch_access (organization_id,membership_id,branch_id) values ('0c100000-0000-4000-8000-000000000001','0c100000-0000-4000-8000-0000000000d1','0c100000-0000-4000-8000-0000000000a1') on conflict do nothing;
insert into public.permissions (id,key,resource,action,description) values
  ('0c100000-0000-4000-8000-0000000000f1','booking.read','booking','read','r'),
  ('0c100000-0000-4000-8000-0000000000f2','booking.update','booking','update','u'),
  ('0c100000-0000-4000-8000-0000000000f3','booking.complete','booking','complete','c'),
  ('0c100000-0000-4000-8000-0000000000f4','membership.read','membership','read','m') on conflict (key) do nothing;
insert into public.role_permissions (organization_id,role_id,permission_id)
  select '0c100000-0000-4000-8000-000000000001','0c100000-0000-4000-8000-0000000000e1',p.id from public.permissions p
  where p.key in ('booking.read','booking.update','booking.complete','membership.read') on conflict do nothing;
insert into public.organization_modules (organization_id,module_id,enabled)
  select '0c100000-0000-4000-8000-000000000001',m.id,true from public.modules m where m.key in ('scheduling','membership')
  on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions (organization_id,status) values ('0c100000-0000-4000-8000-000000000001','active') on conflict do nothing;
insert into public.customers (id,organization_id,display_name) values ('0c100000-0000-4000-8000-00000000c001','0c100000-0000-4000-8000-000000000001','C') on conflict do nothing;
insert into public.pets (id,organization_id,customer_id,name) values ('0c100000-0000-4000-8000-00000000f001','0c100000-0000-4000-8000-000000000001','0c100000-0000-4000-8000-00000000c001','P') on conflict do nothing;
insert into public.service_catalog (id,organization_id,name,base_price,currency,duration_minutes,is_active) values ('0c100000-0000-4000-8000-000000005001','0c100000-0000-4000-8000-000000000001','Bath',100,'USD',60,true) on conflict do nothing;
insert into public.bookings (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at) values
  ('0c100000-0000-4000-8000-00000000ba01','0c100000-0000-4000-8000-000000000001','0c100000-0000-4000-8000-0000000000a1','0c100000-0000-4000-8000-00000000c001','grooming','confirmed',now(),now()+interval '2h') on conflict do nothing;
-- assemble one pet + one line as owner
select set_config('request.jwt.claims', json_build_object('sub','0c100000-0000-4000-8000-0000000000c1','active_org_id','0c100000-0000-4000-8000-000000000001')::text, false);
do $$ declare v_pet uuid; begin
  v_pet := app.assembly_add_pet('0c100000-0000-4000-8000-00000000ba01','0c100000-0000-4000-8000-00000000f001',true);
  perform app.assembly_add_line(v_pet,'0c100000-0000-4000-8000-000000005001',1);
  update public.grooming_job_pets set status='complete' where id=v_pet;
end $$;

-- package + customer package for the reserve-vs-completion concurrency case
insert into public.packages (id,organization_id,name,service_id,total_sessions,price,currency) values
  ('0c100000-0000-4000-8000-00000000a001','0c100000-0000-4000-8000-000000000001','P','0c100000-0000-4000-8000-000000005001',3,240,'USD') on conflict do nothing;
insert into public.customer_packages (id,organization_id,customer_id,package_id,service_id,status) values
  ('0c100000-0000-4000-8000-00000000ca01','0c100000-0000-4000-8000-000000000001','0c100000-0000-4000-8000-00000000c001','0c100000-0000-4000-8000-00000000a001','0c100000-0000-4000-8000-000000005001','active') on conflict do nothing;
insert into public.customer_package_ledger (organization_id,customer_package_id,delta,reason) values
  ('0c100000-0000-4000-8000-000000000001','0c100000-0000-4000-8000-00000000ca01',3,'purchase') on conflict do nothing;
