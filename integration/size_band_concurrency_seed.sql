\set ON_ERROR_STOP on
-- Seeds one isolated dynamic-mode organization per concurrency case.
-- Usage: psql -v idx=<1..9> -f integration/size_band_concurrency_seed.sql
select set_config('request.jwt.claims','{}',false) as c \gset
select set_config('sb.idx',:'idx',false) as i \gset
create function pg_temp.id(n integer) returns uuid language sql immutable as
$$ select ('5f' || lpad(current_setting('sb.idx'),2,'0') || '0000-0000-4000-8000-' || lpad(to_hex(n),12,'0'))::uuid $$;

insert into public.organizations(id,name,slug,status) values (pg_temp.id(1),'Conc '||:idx,'conc-'||:idx,'active');
insert into public.branches(id,organization_id,name,is_default,status) values (pg_temp.id(2),pg_temp.id(1),'B',true,'active');
insert into auth.users(id,email) values (pg_temp.id(3),'conc-owner-'||:idx||'@qc.local');
update public.users set status='active' where id=pg_temp.id(3);
insert into public.roles(id,organization_id,name,is_system) values (pg_temp.id(4),pg_temp.id(1),'Owner',true);
insert into public.memberships(id,organization_id,user_id,role_id,status) values (pg_temp.id(5),pg_temp.id(1),pg_temp.id(3),pg_temp.id(4),'active');
insert into public.membership_branch_access(organization_id,membership_id,branch_id) values (pg_temp.id(1),pg_temp.id(5),pg_temp.id(2));
insert into public.role_permissions(organization_id,role_id,permission_id)
select pg_temp.id(1),pg_temp.id(4),id from public.permissions where key in ('service.manage','booking.update','booking.read','customer.manage') on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
select pg_temp.id(1),id,true from public.modules where key in ('scheduling','crm','membership','finance') on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions(organization_id,status) values (pg_temp.id(1),'active') on conflict do nothing;
insert into public.customers(id,organization_id,display_name,status) values (pg_temp.id(6),pg_temp.id(1),'Conc Customer','active');
insert into public.service_catalog(id,organization_id,name,duration_minutes,base_price,currency) values (pg_temp.id(7),pg_temp.id(1),'Conc Basic',60,100000,'IDR');
update public.organization_size_band_settings set mode='dynamic',layout_version=1 where organization_id=pg_temp.id(1);
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,status) values (pg_temp.id(8),pg_temp.id(1),pg_temp.id(6),'Big','dog',40,'active');
insert into public.packages(id,organization_id,name,service_id,total_sessions,price,currency,per_pet,size_band)
values (pg_temp.id(9),pg_temp.id(1),'Conc Paw XL',pg_temp.id(7),2,1,'IDR',true,'extra_large');
insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at)
values (pg_temp.id(10),pg_temp.id(1),pg_temp.id(2),pg_temp.id(6),'grooming','confirmed',now()+interval '1 day',now()+interval '1 day 2 hours');
insert into public.grooming_jobs(booking_id,organization_id,checklist,photos,metadata) values (pg_temp.id(10),pg_temp.id(1),'{}','[]','{}');
insert into public.grooming_job_pets(id,organization_id,grooming_job_id,pet_id,sequence,status) values (pg_temp.id(11),pg_temp.id(1),pg_temp.id(10),pg_temp.id(8),1,'pending');
