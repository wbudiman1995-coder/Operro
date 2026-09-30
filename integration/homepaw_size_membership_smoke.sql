\set ON_ERROR_STOP on
-- Run after homepaw_qc_smoke.sql on a disposable DB.
select set_config('request.jwt.claims','{}',false);
insert into public.service_catalog(organization_id,name,duration_minutes,base_price,currency,
  price_extra_small,price_small,price_medium,price_large,price_extra_large,price_cat,
  duration_extra_small,duration_small,duration_medium,duration_large,duration_extra_large,duration_cat)
values ('0e000000-0000-4000-8000-000000000001','QC Basic Grooming',60,99000,'IDR',
  99000,120000,170000,230000,269000,120000,60,60,90,120,120,60);

do $$ declare v_customer uuid; v_dog uuid; v_cat uuid; begin
  select id into v_customer from public.customers where display_name='QC Owner Customer';
  select id into v_dog from public.pets where customer_id=v_customer and name='Milo';
  select id into v_cat from public.pets where customer_id=v_customer and name='Luna';
  if (select size from public.pets where id=v_dog) <> 'extra_small' then raise exception '3kg dog was not XS'; end if;
  if (select size from public.pets where id=v_cat) is not null then raise exception 'cat retained a dog-size label'; end if;
  insert into public.pets(organization_id,customer_id,name,species,weight_kg,size,status)
  values
   ('0e000000-0000-4000-8000-000000000001',v_customer,'QC M Dog','dog',12,'small','active'),
   ('0e000000-0000-4000-8000-000000000001',v_customer,'QC XL Dog','dog',26,'large','active');
  if (select size from public.pets where customer_id=v_customer and name='QC M Dog') <> 'medium' then raise exception '12kg dog was not M'; end if;
  if (select size from public.pets where customer_id=v_customer and name='QC XL Dog') <> 'extra_large' then raise exception '26kg dog was not XL'; end if;
  raise notice 'PASS authoritative pet size bands (XS, M, XL, Cat)';
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_pet record; v_job_pet uuid; v_service uuid; v_line uuid; v_expected_price numeric; v_expected_duration integer; begin
  select id into v_service from public.service_catalog where name='QC Basic Grooming';
  for v_pet in select p.id,p.name from public.pets p join public.customers c on c.id=p.customer_id
    where c.display_name='QC Owner Customer' and p.name in ('Milo','Luna','QC M Dog','QC XL Dog') loop
    v_expected_price := case v_pet.name when 'Milo' then 99000 when 'Luna' then 120000 when 'QC M Dog' then 170000 else 269000 end;
    v_expected_duration := case v_pet.name when 'Milo' then 60 when 'Luna' then 60 when 'QC M Dog' then 90 else 120 end;
    v_job_pet := app.assembly_add_pet('0e000000-0000-4000-8000-00000000ba01',v_pet.id,true);
    v_line := app.assembly_add_line(v_job_pet,v_service,1);
    if not exists (select 1 from public.grooming_job_pet_services where id=v_line and unit_price_snapshot=v_expected_price and duration_minutes=v_expected_duration and price_source='size_matrix') then
      raise exception 'wrong price/duration for %',v_pet.name;
    end if;
  end loop;
  raise notice 'PASS booking lines snapshot XS/Cat/M/XL prices and minutes';
end $$;
commit;

insert into public.role_permissions(organization_id,role_id,permission_id)
select '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000e1',id
from public.permissions where key in ('membership.read','membership.manage','invoice.issue') on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
select '0e000000-0000-4000-8000-000000000001',id,true from public.modules where key in ('membership','finance')
on conflict (organization_id,module_id) do update set enabled=true;
insert into public.packages(organization_id,name,service_id,total_sessions,price,currency,per_pet,size_band,discount_percent,visit_interval_days,recurrence_interval,validity_days)
select '0e000000-0000-4000-8000-000000000001','QC Paw Essential XS',id,2,178200,'IDR',true,'extra_small',10,14,'month',31
from public.service_catalog where name='QC Basic Grooming';

do $$ declare v_customer uuid; v_pkg uuid; v_cat uuid; v_dog uuid; begin
  select id into v_customer from public.customers where display_name='QC Owner Customer';
  select id into v_pkg from public.packages where name='QC Paw Essential XS';
  select id into v_cat from public.pets where customer_id=v_customer and name='Luna';
  select id into v_dog from public.pets where customer_id=v_customer and name='Milo';
  begin
    insert into public.customer_packages(organization_id,customer_id,package_id,pet_id,sessions_remaining)
    values('0e000000-0000-4000-8000-000000000001',v_customer,v_pkg,v_cat,0);
    raise exception 'cat bought an XS dog package';
  exception when sqlstate '22023' then
    if sqlerrm <> 'package_size_mismatch' then raise; end if;
  end;
  insert into public.customer_packages(organization_id,customer_id,package_id,pet_id,sessions_remaining)
  values('0e000000-0000-4000-8000-000000000001',v_customer,v_pkg,v_dog,0);
  begin
    update public.packages set size_band='small' where id=v_pkg;
    raise exception 'sold package size changed';
  exception when sqlstate '23514' then
    if sqlerrm <> 'sold_package_size_locked' then raise; end if;
  end;
  raise notice 'PASS size-mismatched sale rejected and sold size locked';
end $$;

select set_config('qc.customer_id',(select id::text from public.customers where display_name='QC Owner Customer'),false);
select set_config('qc.package_id',(select id::text from public.packages where name='QC Paw Essential XS'),false);
select set_config('qc.cat_id',(select p.id::text from public.pets p join public.customers c on c.id=p.customer_id where c.display_name='QC Owner Customer' and p.name='Luna'),false);
select set_config('qc.dog_id',(select p.id::text from public.pets p join public.customers c on c.id=p.customer_id where c.display_name='QC Owner Customer' and p.name='Milo'),false);
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_customer uuid; v_pkg uuid; v_cat uuid; v_dog uuid; v_invoice public.invoices; begin
  v_customer := current_setting('qc.customer_id')::uuid;
  v_pkg := current_setting('qc.package_id')::uuid;
  v_cat := current_setting('qc.cat_id')::uuid;
  v_dog := current_setting('qc.dog_id')::uuid;
  begin
    perform app.create_package_invoice('0e000000-0000-4000-8000-0000000000a1',v_customer,v_pkg,now(),now()+interval '1 day',null,'0e000000-0000-4000-8000-00000000ae01',v_cat);
    raise exception 'RPC allowed cat purchase of XS dog tier';
  exception when sqlstate '22023' then
    if sqlerrm <> 'package_size_mismatch' then raise; end if;
  end;
  v_invoice := app.create_package_invoice('0e000000-0000-4000-8000-0000000000a1',v_customer,v_pkg,now(),now()+interval '1 day',null,'0e000000-0000-4000-8000-00000000ae02',v_dog);
  if v_invoice.id is null or not exists (select 1 from public.customer_packages where source_invoice_id=v_invoice.id and pet_id=v_dog) or
     not exists (select 1 from public.customer_package_ledger where invoice_id=v_invoice.id and delta=2 and reason='purchase') then
    raise exception 'size-matched package invoice did not create linked sessions';
  end if;
  raise notice 'PASS authenticated invoice rejects wrong-size pet and sells matching tier with ledger';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_cp uuid; v_preview jsonb; v_expiry timestamptz; begin
  select cp.id into v_cp from public.customer_packages cp join public.packages pkg on pkg.id=cp.package_id where pkg.name='QC Paw Essential XS';
  select expires_at into v_expiry from public.customer_packages where id=v_cp;
  v_preview := app.preview_package_renewal(v_cp);
  if (v_preview->>'recurrence_interval') <> 'month' or
     (select visit_interval_days from public.packages where name='QC Paw Essential XS') <> 14 or
     abs(extract(epoch from ((v_preview->>'resulting_expires_at')::timestamptz - (greatest(now(),coalesce(v_expiry,now())) + interval '1 month')))) > 5 then
    raise exception 'two-week visit cadence / monthly renewal mismatch: %',v_preview;
  end if;
  raise notice 'PASS two-week visit cadence and monthly renewal are distinct';
end $$;
commit;

update public.pets set weight_kg=26 where id=current_setting('qc.dog_id')::uuid;
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_cp uuid; v_fingerprint text; begin
  select cp.id into v_cp from public.customer_packages cp join public.packages pkg on pkg.id=cp.package_id
  where pkg.name='QC Paw Essential XS' and cp.source_invoice_id is not null;
  v_fingerprint := app.preview_package_renewal(v_cp)->>'terms_fingerprint';
  begin
    perform app.renew_customer_package(v_cp,'0e000000-0000-4000-8000-0000000000a1',now(),now()+interval '1 day',null,'0e000000-0000-4000-8000-00000000ae03',v_fingerprint);
    raise exception 'size-changed pet renewed at XS price';
  exception when sqlstate '22023' then
    if sqlerrm <> 'package_size_mismatch_on_renewal' then raise; end if;
  end;
  raise notice 'PASS pet that grew to XL cannot renew the XS price';
end $$;
commit;
do $$ begin
  if exists (select 1 from public.invoices where request_key='0e000000-0000-4000-8000-00000000ae03') then
    raise exception 'refused renewal left an invoice behind';
  end if;
  raise notice 'PASS refused renewal rolls back invoice';
end $$;
