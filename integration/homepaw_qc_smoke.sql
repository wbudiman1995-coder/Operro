\set ON_ERROR_STOP on
-- Disposable database only: tests anonymous registration and authenticated household creation.
insert into public.organizations(id,name,slug,status)
values ('0e000000-0000-4000-8000-000000000001','QC HomePaw','qc-homepaw','active') on conflict do nothing;
insert into public.branches(id,organization_id,name,is_default,status)
values ('0e000000-0000-4000-8000-0000000000a1','0e000000-0000-4000-8000-000000000001','QC Branch',true,'active') on conflict do nothing;
insert into auth.users(id,email) values ('0e000000-0000-4000-8000-0000000000c1','owner@qc.local') on conflict do nothing;
insert into public.users(id,full_name,email,status)
values ('0e000000-0000-4000-8000-0000000000c1','QC Owner','owner@qc.local','active') on conflict do nothing;
insert into public.roles(id,organization_id,name,is_system)
values ('0e000000-0000-4000-8000-0000000000e1','0e000000-0000-4000-8000-000000000001','Owner',true) on conflict do nothing;
insert into public.memberships(id,organization_id,user_id,role_id,status)
values ('0e000000-0000-4000-8000-0000000000d1','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000c1','0e000000-0000-4000-8000-0000000000e1','active') on conflict do nothing;
insert into public.membership_branch_access(organization_id,membership_id,branch_id)
values ('0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000d1','0e000000-0000-4000-8000-0000000000a1') on conflict do nothing;
insert into public.role_permissions(organization_id,role_id,permission_id)
select '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000e1',id
from public.permissions where key in ('customer.manage','booking.update') on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
select '0e000000-0000-4000-8000-000000000001', id, true from public.modules where key = 'scheduling'
on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions(organization_id,status) values ('0e000000-0000-4000-8000-000000000001','active') on conflict do nothing;
insert into public.customer_onboarding_links(organization_id,token_hash,source)
values ('0e000000-0000-4000-8000-000000000001',encode(extensions.digest('qc-secret-token','sha256'),'hex'),'QC') on conflict do nothing;

begin;
set local role anon;
do $$ declare v_link record; v_id uuid; begin
  select * into v_link from public.get_customer_onboarding_link('qc-secret-token');
  if not v_link.valid or v_link.organization_id <> '0e000000-0000-4000-8000-000000000001' then
    raise exception 'anonymous link lookup failed';
  end if;
  v_id := public.submit_customer_onboarding('qc-secret-token', '{"customerName":"QC Guest","phone":"081234567890","addressLine":"Jalan QC 1","province":"DKI Jakarta","kabupatenKota":"Kota Administrasi Jakarta Selatan","kecamatan":"Kebayoran Baru","pets":[{"name":"Milo","species":"dog"},{"name":"Luna","species":"cat"}]}');
  if v_id is null then raise exception 'anonymous submission failed'; end if;
  raise notice 'PASS anonymous GET and two-pet POST: %', v_id;
end $$;
commit;

insert into public.branch_service_areas(organization_id,branch_id,kabupaten_kota,kecamatan,travel_fee,estimated_travel_minutes)
values ('0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000a1','Jakarta Selatan','Kebayoran Baru',20000,25);
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_zone record; begin
  select * into v_zone from app.fn_check_service_area('0e000000-0000-4000-8000-0000000000a1','Kebayoran Baru','Kota Administrasi Jakarta Selatan');
  if not v_zone.allowed or v_zone.travel_fee <> 20000 then raise exception 'Jakarta alias coverage failed'; end if;
  raise notice 'PASS canonical Jakarta address matches historical service area';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_id uuid; begin
  v_id := app.create_customer_household('QC Owner Customer','081233344455',
    '[{"name":"Milo","species":"dog","size":"small","weightKg":"3"},{"name":"Luna","species":"cat","size":"medium","weightKg":"4"}]',
    '{"label":"Rumah","line1":"Jalan QC 2","province":"DKI Jakarta","kabupaten_kota":"Kota Administrasi Jakarta Selatan","kecamatan":"Kebayoran Baru"}');
  if v_id is null then raise exception 'authenticated household RPC returned null'; end if;
  raise notice 'PASS authenticated household RPC returned: %', v_id;
end $$;
commit;
do $$ declare v_id uuid; v_count integer; begin
  select id into v_id from public.customers where display_name='QC Owner Customer';
  select count(*) into v_count from public.pets where customer_id=v_id;
  if v_count <> 2 then raise exception 'staff household pets: expected 2, got %',v_count; end if;
  if not exists (select 1 from public.customer_addresses where customer_id=v_id and province='DKI Jakarta') then
    raise exception 'staff household address missing';
  end if;
  raise notice 'PASS authenticated two-pet household and address: %', v_id;
end $$;

select set_config('qc.submission_id', (select id::text from public.customer_onboarding_submissions limit 1), false);
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
select app.review_customer_onboarding(current_setting('qc.submission_id')::uuid,'approve',null);
commit;
do $$ declare v_id uuid; begin
  select id into v_id from public.customers where display_name='QC Guest';
  if v_id is null or (select count(*) from public.pets where customer_id=v_id) <> 2 then
    raise exception 'approved anonymous household missing two pets';
  end if;
  if not exists (select 1 from public.customer_addresses where customer_id=v_id and province='DKI Jakarta') then
    raise exception 'approved anonymous household missing province';
  end if;
  raise notice 'PASS admin approved anonymous two-pet household';
end $$;

select set_config('request.jwt.claims','{}',false);
insert into public.service_catalog(organization_id,name,duration_minutes,base_price,currency)
values ('0e000000-0000-4000-8000-000000000001','QC Mandi Kutu',0,25000,'IDR');
do $$ begin
  if not exists (select 1 from public.service_catalog where name='QC Mandi Kutu' and duration_minutes=0 and base_price=25000) then
    raise exception 'zero-time paid service was not saved';
  end if;
  raise notice 'PASS zero-time paid service catalog row';
end $$;

insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at)
select '0e000000-0000-4000-8000-00000000ba01','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000a1',id,'grooming','confirmed',now()+interval '1 day',now()+interval '1 day 2 hours'
from public.customers where display_name='QC Owner Customer';
select set_config('qc.pet_id',(select p.id::text from public.pets p join public.customers c on c.id=p.customer_id where c.display_name='QC Owner Customer' and p.name='Milo'),false);
select set_config('qc.service_id',(select id::text from public.service_catalog where name='QC Mandi Kutu'),false);
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_pet uuid; v_job_pet uuid; v_service uuid; v_line uuid; begin
  v_pet := current_setting('qc.pet_id')::uuid;
  v_service := current_setting('qc.service_id')::uuid;
  v_job_pet := app.assembly_add_pet('0e000000-0000-4000-8000-00000000ba01',v_pet,true);
  v_line := app.assembly_add_line(v_job_pet,v_service,1);
  if v_line is null then raise exception 'assembly add-on line returned null'; end if;
end $$;
commit;
do $$ begin
  if not exists (select 1 from public.grooming_job_pet_services where service_id=current_setting('qc.service_id')::uuid and duration_minutes=0 and unit_price_snapshot=25000) then
    raise exception 'zero-time paid add-on did not reach grooming line';
  end if;
  raise notice 'PASS paid add-on line has zero minutes and Rp 25.000 price';
end $$;
