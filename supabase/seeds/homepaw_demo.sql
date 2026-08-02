-- =====================================================================
-- HOMEPAW DEMO SEED
-- Purpose: idempotent, isolated dataset for end-to-end Operro pilot testing.
-- Target:  public.users email below. Change only v_owner_email if required.
-- Safety:  creates/updates the dedicated `homepaw-demo` organization only.
--          It does not modify the existing HomePaw organization or migrations.
-- =====================================================================

do $$
declare
  v_owner_email text := 'wbudiman1995@gmail.com';
  v_owner_user uuid;
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
  v_role uuid := 'd0000000-0000-4000-8000-000000000002';
  v_member uuid := 'd0000000-0000-4000-8000-000000000003';
  v_branch uuid := 'd0000000-0000-4000-8000-000000000010';
  v_start timestamptz;
begin
  select id into v_owner_user from public.users where lower(email) = lower(v_owner_email) and deleted_at is null;
  if v_owner_user is null then raise exception 'Operro user % was not found. Sign in once or edit v_owner_email.', v_owner_email; end if;

  insert into public.organizations (id,name,slug,status,vertical,settings)
  values (v_org,'HomePaw Demo','homepaw-demo','active','grooming','{"currency":"IDR","timezone":"Asia/Jakarta","demo_seed":"homepaw_v1"}')
  on conflict (id) do update set status='active', deleted_at=null, settings=excluded.settings;
  insert into public.roles (id,organization_id,name,description,is_system)
  values (v_role,v_org,'Pemilik Demo','Akses penuh untuk pilot HomePaw',true)
  on conflict (id) do update set deleted_at=null;
  insert into public.memberships (id,user_id,organization_id,role_id,status)
  values (v_member,v_owner_user,v_org,v_role,'active')
  on conflict (user_id,organization_id) do update set role_id=excluded.role_id,status='active',deleted_at=null;
  insert into public.role_permissions (role_id,permission_id,organization_id)
  select v_role,p.id,v_org from public.permissions p on conflict do nothing;
  insert into public.subscriptions (id,organization_id,status,current_period_start,current_period_end)
  values ('d0000000-0000-4000-8000-000000000004',v_org,'active',now()-interval '1 day',now()+interval '1 year')
  on conflict (id) do update set status='active',current_period_end=excluded.current_period_end,deleted_at=null;
  insert into public.organization_modules (organization_id,module_id,enabled,source)
  select v_org,m.id,true,'override' from public.modules m on conflict (organization_id,module_id) do update set enabled=true,source='override';

  insert into public.branches (id,organization_id,name,status,timezone,is_default,address,settings)
  values (v_branch,v_org,'HomePaw Kelapa Gading','active','Asia/Jakarta',true,'{"city":"Jakarta Utara","area":"Kelapa Gading"}','{"service_radius_km":12,"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set status='active',deleted_at=null;

  insert into public.service_catalog (id,organization_id,name,description,category,duration_minutes,base_price,currency,required_skill,required_photos,sop,fulfillment_modes,is_active,metadata) values
  ('d0000000-0000-4000-8000-000000000101',v_org,'Basic Grooming','Mandi, blow dry, telinga dan kuku','grooming',90,175000,'IDR','grooming',2,'{"steps":["before_photo","bath","dry","ears","nails","after_photo"]}','["home","in_store"]',true,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000102',v_org,'Full Grooming','Basic grooming dan potong model','grooming',150,300000,'IDR','grooming',3,'{"steps":["before_photo","bath","dry","cut","finish","after_photo"]}','["home","in_store"]',true,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000103',v_org,'De-shedding','Perawatan bulu rontok intensif','treatment',60,125000,'IDR','grooming',2,'{}','["home","in_store"]',true,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000104',v_org,'Anti Kutu','Treatment kutu dan bilas khusus','treatment',45,100000,'IDR','grooming',2,'{}','["home","in_store"]',true,'{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set name=excluded.name,duration_minutes=excluded.duration_minutes,base_price=excluded.base_price,is_active=true,deleted_at=null;

  insert into public.resources (id,organization_id,branch_id,kind,name,capacity,skills,status,settings,metadata) values
  ('d0000000-0000-4000-8000-000000000201',v_org,v_branch,'staff','Andi',1,'["grooming","small_dog"]','active','{"phone":"081200000201"}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000202',v_org,v_branch,'staff','Sari',1,'["grooming","cat"]','active','{"phone":"081200000202"}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000203',v_org,v_branch,'staff','Bima',1,'["grooming","large_dog"]','active','{"phone":"081200000203"}','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set name=excluded.name,status='active',deleted_at=null;

  insert into public.customers (id,organization_id,display_name,phone,address,status,source,tags,notes,metadata) values
  ('d0000000-0000-4000-8000-000000000301',v_org,'Cynthia Tan','081210000301','{"area":"Kelapa Gading"}','active','Instagram','["repeat","demo"]','Suka jadwal pagi','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000302',v_org,'Rico Wijaya','081210000302','{"area":"Sunter"}','active','Referral','["package","demo"]','Hubungi via WhatsApp','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000303',v_org,'Maya Putri','081210000303','{"area":"Pulomas"}','active','Google','["new","demo"]',null,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000304',v_org,'Jonathan Lim','081210000304','{"area":"Kelapa Gading"}','active','Instagram','["repeat","demo"]','Anjing sensitif suara dryer','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000305',v_org,'Nadia Sari','081210000305','{"area":"Cempaka Putih"}','active','Referral','["multi-pet","demo"]',null,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000306',v_org,'Kevin Halim','081210000306','{"area":"Sunter"}','active','Walk-in','["demo"]',null,'{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set display_name=excluded.display_name,phone=excluded.phone,status='active',deleted_at=null;

  insert into public.pets (id,organization_id,customer_id,name,species,breed,sex,weight_kg,temperament,status,medical_flags,metadata) values
  ('d0000000-0000-4000-8000-000000000401',v_org,'d0000000-0000-4000-8000-000000000301','Bubu','dog','Toy Poodle','male',4.2,'Friendly','active','{}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000402',v_org,'d0000000-0000-4000-8000-000000000302','Mochi','dog','Shih Tzu','female',5.8,'Calm','active','{"skin":"sensitive"}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000403',v_org,'d0000000-0000-4000-8000-000000000303','Oreo','cat','Domestic Shorthair','male',4.9,'Alert','active','{}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000404',v_org,'d0000000-0000-4000-8000-000000000304','Leo','dog','Golden Retriever','male',29.0,'Nervous with dryer','active','{}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000405',v_org,'d0000000-0000-4000-8000-000000000305','Kiki','dog','Pomeranian','female',3.9,'Friendly','active','{}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000406',v_org,'d0000000-0000-4000-8000-000000000305','Koko','dog','Pomeranian','male',4.4,'Energetic','active','{}','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000407',v_org,'d0000000-0000-4000-8000-000000000306','Snowy','dog','Maltese','female',4.1,'Calm','active','{}','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set name=excluded.name,status='active',deleted_at=null;

  -- Dynamic schedule anchored to the current Jakarta week.
  v_start := (((now() at time zone 'Asia/Jakarta')::date + time '09:00') at time zone 'Asia/Jakarta');
  insert into public.bookings (id,organization_id,branch_id,customer_id,booking_type,status,fulfillment_mode,starts_at,ends_at,service_name_snapshot,price_snapshot,currency,notes,metadata) values
  ('d0000000-0000-4000-8000-000000000501',v_org,v_branch,'d0000000-0000-4000-8000-000000000301','grooming','completed','home',v_start-interval '1 day',v_start-interval '1 day'+interval '90 minutes','Basic Grooming',175000,'IDR','Demo selesai','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000502',v_org,v_branch,'d0000000-0000-4000-8000-000000000302','grooming','confirmed','home',v_start,v_start+interval '90 minutes','Basic Grooming',175000,'IDR','Kulit sensitif','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000503',v_org,v_branch,'d0000000-0000-4000-8000-000000000303','grooming','in_progress','in_store',v_start+interval '2 hours',v_start+interval '3 hours','De-shedding',125000,'IDR','Kucing, gunakan dryer rendah','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000504',v_org,v_branch,'d0000000-0000-4000-8000-000000000304','grooming','confirmed','home',v_start+interval '1 day',v_start+interval '1 day 150 minutes','Full Grooming',300000,'IDR','Bawa dryer senyap','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000505',v_org,v_branch,'d0000000-0000-4000-8000-000000000305','grooming','confirmed','home',v_start+interval '1 day 3 hours',v_start+interval '1 day 5 hours','Basic Grooming',350000,'IDR','Dua hewan','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000506',v_org,v_branch,'d0000000-0000-4000-8000-000000000306','grooming','requested','pickup_delivery',v_start+interval '2 days',v_start+interval '2 days 90 minutes','Basic Grooming',175000,'IDR','Pickup pukul 08:30','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set starts_at=excluded.starts_at,ends_at=excluded.ends_at,status=excluded.status,deleted_at=null;

  insert into public.grooming_jobs (booking_id,organization_id,checklist,photos,groomer_notes,metadata)
  select id,v_org,'{}','[]',null,'{"demo_seed":"homepaw_v1"}' from public.bookings where organization_id=v_org and metadata->>'demo_seed'='homepaw_v1'
  on conflict (booking_id) do nothing;
  insert into public.grooming_job_pets (id,organization_id,grooming_job_id,pet_id,sequence,assigned_resource_id,status,metadata) values
  ('d0000000-0000-4000-8000-000000000601',v_org,'d0000000-0000-4000-8000-000000000501','d0000000-0000-4000-8000-000000000401',1,'d0000000-0000-4000-8000-000000000201','complete','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000602',v_org,'d0000000-0000-4000-8000-000000000502','d0000000-0000-4000-8000-000000000402',1,'d0000000-0000-4000-8000-000000000201','pending','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000603',v_org,'d0000000-0000-4000-8000-000000000503','d0000000-0000-4000-8000-000000000403',1,'d0000000-0000-4000-8000-000000000202','in_progress','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000604',v_org,'d0000000-0000-4000-8000-000000000504','d0000000-0000-4000-8000-000000000404',1,'d0000000-0000-4000-8000-000000000203','pending','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000605',v_org,'d0000000-0000-4000-8000-000000000505','d0000000-0000-4000-8000-000000000405',1,'d0000000-0000-4000-8000-000000000201','pending','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000606',v_org,'d0000000-0000-4000-8000-000000000505','d0000000-0000-4000-8000-000000000406',2,'d0000000-0000-4000-8000-000000000202','pending','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000607',v_org,'d0000000-0000-4000-8000-000000000506','d0000000-0000-4000-8000-000000000407',1,'d0000000-0000-4000-8000-000000000203','pending','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set status=excluded.status,assigned_resource_id=excluded.assigned_resource_id,deleted_at=null;
  insert into public.grooming_job_pet_services (id,organization_id,grooming_job_pet_id,service_id,service_name_snapshot,duration_minutes,quantity,unit_price_snapshot,currency,assigned_resource_id,metadata) values
  ('d0000000-0000-4000-8000-000000000701',v_org,'d0000000-0000-4000-8000-000000000601','d0000000-0000-4000-8000-000000000101','Basic Grooming',90,1,175000,'IDR','d0000000-0000-4000-8000-000000000201','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000702',v_org,'d0000000-0000-4000-8000-000000000602','d0000000-0000-4000-8000-000000000101','Basic Grooming',90,1,175000,'IDR','d0000000-0000-4000-8000-000000000201','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000703',v_org,'d0000000-0000-4000-8000-000000000603','d0000000-0000-4000-8000-000000000103','De-shedding',60,1,125000,'IDR','d0000000-0000-4000-8000-000000000202','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000704',v_org,'d0000000-0000-4000-8000-000000000604','d0000000-0000-4000-8000-000000000102','Full Grooming',150,1,300000,'IDR','d0000000-0000-4000-8000-000000000203','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000705',v_org,'d0000000-0000-4000-8000-000000000605','d0000000-0000-4000-8000-000000000101','Basic Grooming',90,1,175000,'IDR','d0000000-0000-4000-8000-000000000201','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000706',v_org,'d0000000-0000-4000-8000-000000000606','d0000000-0000-4000-8000-000000000101','Basic Grooming',90,1,175000,'IDR','d0000000-0000-4000-8000-000000000202','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000707',v_org,'d0000000-0000-4000-8000-000000000607','d0000000-0000-4000-8000-000000000101','Basic Grooming',90,1,175000,'IDR','d0000000-0000-4000-8000-000000000203','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do nothing;
  insert into public.booking_resources (booking_id,resource_id,organization_id,during,is_active)
  select b.id,g.assigned_resource_id,v_org,tstzrange(b.starts_at,b.ends_at,'[)'),b.status not in ('canceled','no_show') from public.bookings b join public.grooming_job_pets g on g.grooming_job_id=b.id and g.organization_id=b.organization_id where b.organization_id=v_org
  on conflict (booking_id,resource_id) do update set during=excluded.during,is_active=excluded.is_active;

  insert into public.tasks (id,organization_id,branch_id,booking_id,title,status,priority,due_at,metadata) values
  ('d0000000-0000-4000-8000-000000000801',v_org,v_branch,'d0000000-0000-4000-8000-000000000502','Konfirmasi kondisi kulit Mochi','todo','high',v_start-interval '1 hour','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000802',v_org,v_branch,null,'Cek stok shampoo sensitive','in_progress','normal',v_start+interval '4 hours','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000803',v_org,v_branch,'d0000000-0000-4000-8000-000000000506','Atur rute pickup Snowy','todo','urgent',v_start+interval '1 day 20 hours','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000804',v_org,v_branch,null,'Follow-up pelanggan tidak aktif','done','low',v_start-interval '2 days','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set status=excluded.status,due_at=excluded.due_at,deleted_at=null;

  insert into public.packages (id,organization_id,name,description,service_id,total_sessions,price,currency,validity_days,is_active,metadata) values
  ('d0000000-0000-4000-8000-000000000901',v_org,'Paket Basic 5x','Lima kali Basic Grooming','d0000000-0000-4000-8000-000000000101',5,750000,'IDR',180,true,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000902',v_org,'Paket Bebas 3x','Tiga sesi untuk layanan grooming',null,3,480000,'IDR',120,true,'{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set price=excluded.price,is_active=true,deleted_at=null;
  insert into public.customer_packages (id,organization_id,customer_id,package_id,service_id,sessions_remaining,purchased_at,expires_at,status,source_ref,metadata) values
  ('d0000000-0000-4000-8000-000000000911',v_org,'d0000000-0000-4000-8000-000000000302','d0000000-0000-4000-8000-000000000901','d0000000-0000-4000-8000-000000000101',0,now()-interval '30 days',now()+interval '150 days','active','DEMO-PKG-001','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000000912',v_org,'d0000000-0000-4000-8000-000000000305','d0000000-0000-4000-8000-000000000902',null,0,now()-interval '10 days',now()+interval '110 days','active','DEMO-PKG-002','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set status='active',deleted_at=null;
  insert into public.customer_package_ledger (id,organization_id,customer_package_id,delta,reason,notes) values
  ('d0000000-0000-4000-8000-000000000921',v_org,'d0000000-0000-4000-8000-000000000911',5,'purchase','demo_seed:homepaw_v1 purchase'),
  ('d0000000-0000-4000-8000-000000000922',v_org,'d0000000-0000-4000-8000-000000000911',-2,'adjustment','demo_seed:homepaw_v1 two sessions used'),
  ('d0000000-0000-4000-8000-000000000923',v_org,'d0000000-0000-4000-8000-000000000912',3,'purchase','demo_seed:homepaw_v1 purchase'),
  ('d0000000-0000-4000-8000-000000000924',v_org,'d0000000-0000-4000-8000-000000000912',-1,'adjustment','demo_seed:homepaw_v1 one session used')
  on conflict (id) do nothing;

  insert into public.product_catalog (id,organization_id,sku,name,category,unit,cost_price,selling_price,currency,supplier,is_active,metadata) values
  ('d0000000-0000-4000-8000-000000001001',v_org,'SHP-SENS-1L','Shampoo Sensitive 1L','shampoo','bottle',85000,125000,'IDR','Demo Supplier',true,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001002',v_org,'SHP-REG-1L','Shampoo Regular 1L','shampoo','bottle',65000,100000,'IDR','Demo Supplier',true,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001003',v_org,'COND-1L','Conditioner 1L','conditioner','bottle',70000,110000,'IDR','Demo Supplier',true,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001004',v_org,'TOWEL-M','Handuk Microfiber','equipment','each',30000,50000,'IDR','Demo Supplier',true,'{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set name=excluded.name,is_active=true,deleted_at=null;
  insert into public.inventory_movements (id,organization_id,branch_id,product_id,movement_type,quantity,unit_cost,notes,metadata) values
  ('d0000000-0000-4000-8000-000000001011',v_org,v_branch,'d0000000-0000-4000-8000-000000001001','opening_balance',4,85000,'Stok awal demo','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001012',v_org,v_branch,'d0000000-0000-4000-8000-000000001002','opening_balance',12,65000,'Stok awal demo','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001013',v_org,v_branch,'d0000000-0000-4000-8000-000000001003','opening_balance',7,70000,'Stok awal demo','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001014',v_org,v_branch,'d0000000-0000-4000-8000-000000001004','opening_balance',3,30000,'Stok awal demo','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do nothing;

  insert into public.invoices (id,organization_id,branch_id,customer_id,invoice_number,status,currency,subtotal,discount_total,tax_total,total,issued_at,due_at,metadata) values
  ('d0000000-0000-4000-8000-000000001101',v_org,v_branch,'d0000000-0000-4000-8000-000000000301','DEMO-INV-001','paid','IDR',175000,0,0,175000,now()-interval '1 day',now()-interval '1 day','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001102',v_org,v_branch,'d0000000-0000-4000-8000-000000000302','DEMO-INV-002','issued','IDR',175000,0,0,175000,now(),now()+interval '1 day','{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001103',v_org,v_branch,'d0000000-0000-4000-8000-000000000304','DEMO-INV-003','issued','IDR',300000,0,0,300000,now(),now()+interval '2 days','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do nothing;
  insert into public.payments (id,organization_id,branch_id,invoice_id,customer_id,method,amount,currency,status,external_ref,paid_at,metadata) values
  ('d0000000-0000-4000-8000-000000001111',v_org,v_branch,'d0000000-0000-4000-8000-000000001101','d0000000-0000-4000-8000-000000000301','bank_transfer',175000,'IDR','succeeded','DEMO-TRF-001',now()-interval '1 day','{"demo_seed":"homepaw_v1"}')
  on conflict (id) do nothing;
  insert into public.expenses (id,organization_id,branch_id,category,description,amount,currency,status,vendor,incurred_at,metadata) values
  ('d0000000-0000-4000-8000-000000001121',v_org,v_branch,'Supplies','Pembelian shampoo dan conditioner',425000,'IDR','recorded','Demo Supplier',current_date,'{"demo_seed":"homepaw_v1"}'),
  ('d0000000-0000-4000-8000-000000001122',v_org,v_branch,'Transport','Bensin operasional groomer',150000,'IDR','recorded','SPBU',current_date,'{"demo_seed":"homepaw_v1"}')
  on conflict (id) do update set amount=excluded.amount,status=excluded.status,deleted_at=null;

  raise notice 'HomePaw Demo ready for %. Switch workspace to HomePaw Demo and refresh the session.', v_owner_email;
end $$;
