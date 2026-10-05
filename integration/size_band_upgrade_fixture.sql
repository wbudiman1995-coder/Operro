\set ON_ERROR_STOP on
-- Extra populated-upgrade data, loaded by run_populated_upgrade_rehearsal.sh on
-- the pre-SB lineage (head before 20261023100000), so the size-band migrations
-- are applied to realistic existing rows. Disposable database only.
--  X: custom boundaries 6/11/16/26, matrix prices, snapshot line, package, paid payroll
--  Y: NO boundary row (defaults), base-only service, species pet, unmeasured pets
--  Z: soft-deleted organization still holding pets, a sized package and an entitlement
select set_config('request.jwt.claims','{}',false) as c \gset

insert into public.organizations(id,name,slug,status,vertical) values
  ('5c000000-0000-4000-8000-000000000001','Upgrade X','upgrade-x','active','grooming'),
  ('5c000000-0000-4000-8000-000000000002','Upgrade Y','upgrade-y','active','grooming'),
  ('5c000000-0000-4000-8000-000000000003','Upgrade Z','upgrade-z','active','grooming');
insert into public.organization_dog_size_boundaries(organization_id,xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg) values
  ('5c000000-0000-4000-8000-000000000001',6,11,16,26),
  ('5c000000-0000-4000-8000-000000000003',4,9,14,24);
insert into public.organization_pet_types(organization_id,key,label) values
  ('5c000000-0000-4000-8000-000000000001','rabbit','Kelinci'),('5c000000-0000-4000-8000-000000000002','rabbit','Kelinci');

insert into public.branches(id,organization_id,name,is_default,status) values
  ('5c000000-0000-4000-8000-0000000000b1','5c000000-0000-4000-8000-000000000001','X Branch',true,'active');
insert into auth.users(id,email) values ('5c000000-0000-4000-8000-0000000000a1','upgrade-x@local.test');
insert into public.users(id,full_name,email,status) values ('5c000000-0000-4000-8000-0000000000a1','Upgrade X Owner','upgrade-x@local.test','active')
  on conflict (id) do update set full_name=excluded.full_name;
insert into public.roles(id,organization_id,name,is_system) values ('5c000000-0000-4000-8000-0000000000a2','5c000000-0000-4000-8000-000000000001','Owner',true);
insert into public.memberships(id,organization_id,user_id,role_id,status) values
  ('5c000000-0000-4000-8000-0000000000a3','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000a1','5c000000-0000-4000-8000-0000000000a2','active');

insert into public.customers(id,organization_id,display_name,status) values
  ('5c000000-0000-4000-8000-0000000000c1','5c000000-0000-4000-8000-000000000001','X Customer','active'),
  ('5c000000-0000-4000-8000-0000000000c2','5c000000-0000-4000-8000-000000000002','Y Customer','active'),
  ('5c000000-0000-4000-8000-0000000000c3','5c000000-0000-4000-8000-000000000003','Z Customer','active');

-- pets: weighted at every X/Y/Z boundary edge, unmeasured with a legacy size, cat, custom species
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,size,status)
select ('5c000000-0000-4000-8000-0000000001' || lpad(n::text,2,'0'))::uuid, o.org, o.cust, 'X'||n, 'dog', w, null, 'active'
from (values ('5c000000-0000-4000-8000-000000000001'::uuid,'5c000000-0000-4000-8000-0000000000c1'::uuid,0)) o(org,cust,z),
     (values (1,0.5),(2,5.99),(3,6.00),(4,10.99),(5,11.00),(6,15.99),(7,16.00),(8,25.99),(9,26.00),(10,26.01),(11,40.00),(12,20.00)) v(n,w);
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,size,status) values
  ('5c000000-0000-4000-8000-000000000201','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000c1','X manual','dog',null,'medium','active'),
  ('5c000000-0000-4000-8000-000000000202','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000c1','X cat','cat',4,null,'active'),
  ('5c000000-0000-4000-8000-000000000203','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000c1','X rabbit','rabbit',2,null,'active'),
  ('5c000000-0000-4000-8000-000000000211','5c000000-0000-4000-8000-000000000002','5c000000-0000-4000-8000-0000000000c2','Y d25','dog',25.00,null,'active'),
  ('5c000000-0000-4000-8000-000000000212','5c000000-0000-4000-8000-000000000002','5c000000-0000-4000-8000-0000000000c2','Y d2501','dog',25.01,null,'active'),
  ('5c000000-0000-4000-8000-000000000213','5c000000-0000-4000-8000-000000000002','5c000000-0000-4000-8000-0000000000c2','Y manual','dog',null,'extra_large','active'),
  ('5c000000-0000-4000-8000-000000000214','5c000000-0000-4000-8000-000000000002','5c000000-0000-4000-8000-0000000000c2','Y unsized','dog',null,null,'active'),
  ('5c000000-0000-4000-8000-000000000215','5c000000-0000-4000-8000-000000000002','5c000000-0000-4000-8000-0000000000c2','Y rabbit','rabbit',1.5,null,'active'),
  ('5c000000-0000-4000-8000-000000000221','5c000000-0000-4000-8000-000000000003','5c000000-0000-4000-8000-0000000000c3','Z tiny','dog',3,null,'active'),
  ('5c000000-0000-4000-8000-000000000222','5c000000-0000-4000-8000-000000000003','5c000000-0000-4000-8000-0000000000c3','Z big','dog',30,null,'active');
-- a soft-deleted pet keeps its legacy size
update public.pets set deleted_at=now() where id='5c000000-0000-4000-8000-000000000222';

insert into public.service_catalog(id,organization_id,name,duration_minutes,base_price,currency,additional_duration_minutes,payroll_role,
  price_extra_small,price_small,price_medium,price_large,price_extra_large,price_cat,
  duration_extra_small,duration_small,duration_medium,duration_large,duration_extra_large,duration_cat,species_pricing) values
 ('5c000000-0000-4000-8000-000000000301','5c000000-0000-4000-8000-000000000001','X Basic Grooming',60,99000,'IDR',15,'basic_grooming',99000,120000,170000,230000,269000,125000,50,60,90,120,130,45,'{"rabbit":{"price":70000,"duration":40}}'),
 ('5c000000-0000-4000-8000-000000000302','5c000000-0000-4000-8000-000000000001','X Zero Addon',0,25000,'IDR',0,null,null,null,null,null,null,null,null,null,null,null,null,null,'{}'),
 ('5c000000-0000-4000-8000-000000000303','5c000000-0000-4000-8000-000000000002','Y Base Only',45,50000,'IDR',0,null,null,null,null,null,null,null,null,null,null,null,null,null,'{"rabbit":{"price":30000,"duration":20}}'),
 ('5c000000-0000-4000-8000-000000000304','5c000000-0000-4000-8000-000000000003','Z Basic',60,80000,'IDR',0,null,80000,90000,null,null,null,null,null,null,null,null,null,null,'{}');
-- a soft-deleted service with a matrix must still backfill
update public.service_catalog set deleted_at=now(),is_active=false where id='5c000000-0000-4000-8000-000000000304';

-- booking + immutable line snapshots (X)
insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at,service_name_snapshot,price_snapshot,currency)
values ('5c000000-0000-4000-8000-000000000401','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000b1','5c000000-0000-4000-8000-0000000000c1','grooming','completed',now()-interval '2 day',now()-interval '2 day'+interval '2 hours','X Basic Grooming',230000,'IDR');
insert into public.grooming_jobs(booking_id,organization_id,checklist,photos,metadata)
values ('5c000000-0000-4000-8000-000000000401','5c000000-0000-4000-8000-000000000001','{}','[]','{}');
insert into public.grooming_job_pets(id,organization_id,grooming_job_id,pet_id,sequence,status) values
  ('5c000000-0000-4000-8000-000000000501','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000401','5c000000-0000-4000-8000-000000000112',1,'complete'),
  ('5c000000-0000-4000-8000-000000000502','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000401','5c000000-0000-4000-8000-000000000202',2,'complete'),
  ('5c000000-0000-4000-8000-000000000503','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000401','5c000000-0000-4000-8000-000000000203',3,'complete');
insert into public.grooming_job_pet_services(id,organization_id,grooming_job_pet_id,service_id,service_name_snapshot,duration_minutes,quantity,unit_price_snapshot,currency,pet_size_snapshot,price_source) values
  ('5c000000-0000-4000-8000-000000000601','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000501','5c000000-0000-4000-8000-000000000301','X Basic Grooming',120,1,230000,'IDR','large','size_matrix'),
  ('5c000000-0000-4000-8000-000000000602','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000502','5c000000-0000-4000-8000-000000000301','X Basic Grooming',45,1,125000,'IDR','cat','size_matrix'),
  ('5c000000-0000-4000-8000-000000000603','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000503','5c000000-0000-4000-8000-000000000301','X Basic Grooming',40,1,70000,'IDR','rabbit','size_matrix'),
  ('5c000000-0000-4000-8000-000000000604','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000501','5c000000-0000-4000-8000-000000000302','X Zero Addon',0,1,25000,'IDR','large','base');

-- sized packages and entitlements (X and soft-deleted Z)
insert into public.packages(id,organization_id,name,service_id,total_sessions,price,currency,per_pet,size_band,recurrence_interval) values
  ('5c000000-0000-4000-8000-000000000701','5c000000-0000-4000-8000-000000000001','X Paw Large','5c000000-0000-4000-8000-000000000301',4,800000,'IDR',true,'large','month'),
  ('5c000000-0000-4000-8000-000000000702','5c000000-0000-4000-8000-000000000001','X Paw Cat','5c000000-0000-4000-8000-000000000301',4,400000,'IDR',true,'cat','month'),
  ('5c000000-0000-4000-8000-000000000703','5c000000-0000-4000-8000-000000000003','Z Paw XS','5c000000-0000-4000-8000-000000000304',2,150000,'IDR',true,'extra_small','month'),
  ('5c000000-0000-4000-8000-000000000704','5c000000-0000-4000-8000-000000000002','Y Plain',null,3,90000,'IDR',false,null,'none');
insert into public.customer_packages(id,organization_id,customer_id,package_id,pet_id,sessions_remaining) values
  ('5c000000-0000-4000-8000-000000000801','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000c1','5c000000-0000-4000-8000-000000000701','5c000000-0000-4000-8000-000000000112',4),
  ('5c000000-0000-4000-8000-000000000802','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000c1','5c000000-0000-4000-8000-000000000702','5c000000-0000-4000-8000-000000000202',4),
  ('5c000000-0000-4000-8000-000000000803','5c000000-0000-4000-8000-000000000003','5c000000-0000-4000-8000-0000000000c3','5c000000-0000-4000-8000-000000000703','5c000000-0000-4000-8000-000000000221',2);
insert into public.customer_package_ledger(id,organization_id,customer_package_id,delta,reason)
values ('5c000000-0000-4000-8000-000000000811','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000801',1,'adjustment');

-- invoice with a line, and a paid/published payroll run carrying a frozen breakdown (X)
insert into public.invoices(id,organization_id,branch_id,customer_id,invoice_number,status,currency,subtotal,discount_total,tax_total,total,issued_at,due_at,metadata)
values ('5c000000-0000-4000-8000-000000000901','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000b1','5c000000-0000-4000-8000-0000000000c1','UPG-X-001','paid','IDR',255000,0,0,255000,now()-interval '1 day',now()-interval '1 day','{}');
insert into public.payroll_runs(id,organization_id,period_start,period_end,status,currency)
values ('5c000000-0000-4000-8000-000000000a01','5c000000-0000-4000-8000-000000000001',current_date-30,current_date-1,'draft','IDR');
insert into public.payroll_items(id,organization_id,payroll_run_id,membership_id,base_pay,commission_total,gross_pay,net_pay,breakdown)
values ('5c000000-0000-4000-8000-000000000a11','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-000000000a01','5c000000-0000-4000-8000-0000000000a3',1000000,150000,1150000,1150000,
  '{"perDog":{"small":15000,"extra_small":20000},"note":"frozen before size bands"}'::jsonb);
update public.payroll_runs set status='approved',approved_at=now() where id='5c000000-0000-4000-8000-000000000a01';
update public.payroll_runs set status='paid',paid_at=now() where id='5c000000-0000-4000-8000-000000000a01';

-- Z becomes a soft-deleted organization
update public.organizations set deleted_at=now(), status='deleted' where id='5c000000-0000-4000-8000-000000000003';
