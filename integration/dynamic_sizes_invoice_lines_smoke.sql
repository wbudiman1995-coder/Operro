\set ON_ERROR_STOP on
-- Run on a disposable DB after homepaw_qc_smoke.sql.
begin;
insert into public.organizations(id,name,slug,status)
values ('0e000000-0000-4000-8000-000000000002','QC Other Tenant','qc-other-tenant','active');
insert into public.role_permissions(organization_id,role_id,permission_id)
select '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000e1',id
from public.permissions where key in ('invoice.issue','finance.read','order.read','membership.manage','booking.read','customer.read') on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
select '0e000000-0000-4000-8000-000000000001',id,true from public.modules where key in ('finance','pos','membership','crm')
on conflict (organization_id,module_id) do update set enabled=true;

insert into public.service_catalog(organization_id,name,duration_minutes,base_price,currency,dog_size_pricing)
values ('0e000000-0000-4000-8000-000000000001','Dynamic Grooming QC',60,99000,'IDR',
  '{"xxl":{"price":350000,"duration":180}}'::jsonb);
insert into public.pets(organization_id,customer_id,name,species,weight_kg,status)
select '0e000000-0000-4000-8000-000000000001',id,'XXL QC Dog','dog',45,'active'
from public.customers where display_name='QC Owner Customer';
insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at)
select '0e000000-0000-4000-8000-00000000ba02',
  '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000a1',id,
  'grooming','draft',now()+interval '1 day',now()+interval '1 day 4 hours'
from public.customers where display_name='QC Owner Customer';
insert into public.manual_visits(id,organization_id,branch_id,customer_id,visit_at,description)
select '0e000000-0000-4000-8000-0000000000f1',
  '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000a1',id,
  now(),'Manual grooming QC' from public.customers where display_name='QC Owner Customer';

set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_org uuid:='0e000000-0000-4000-8000-000000000001'; v_pkg uuid; v_pet uuid; v_service uuid; v_invoice public.invoices; v_again public.invoices; v_job_pet uuid; v_line uuid; v_issued timestamptz:=date_trunc('second',now()); v_due timestamptz; begin
  v_due:=v_issued+interval '7 days';
  perform app.replace_dog_size_bands(v_org,'[
    {"key":"extra_small","label":"XS","upperKg":5},
    {"key":"small","label":"S","upperKg":10},
    {"key":"medium","label":"M","upperKg":15},
    {"key":"large","label":"L","upperKg":25.01},
    {"key":"extra_large","label":"XL","upperKg":40},
    {"key":"xxl","label":"XXL","upperKg":null}
  ]'::jsonb);
  select id into v_pet from public.pets where organization_id=v_org and name='XXL QC Dog';
  select id into v_service from public.service_catalog where organization_id=v_org and name='Dynamic Grooming QC';
  raise notice 'fixture pet %, service %',v_pet,v_service;
  if (select size from public.pets where id=v_pet)<>'xxl' then
    raise exception 'XXL size mapping failed'; end if;
  v_job_pet:=app.assembly_add_pet('0e000000-0000-4000-8000-00000000ba02',v_pet,true);
  v_line:=app.assembly_add_line(v_job_pet,v_service,1);
  if not exists (select 1 from public.grooming_job_pet_services where id=v_line
     and unit_price_snapshot=350000 and duration_minutes=180 and pet_size_snapshot='xxl') then
    raise exception 'XXL booking snapshot price or duration failed'; end if;
  raise notice 'PASS XXL weight, booking price and duration';

  insert into public.packages(organization_id,name,service_id,total_sessions,price,currency,per_pet,size_band)
  values(v_org,'XXL QC Package',v_service,1,350000,'IDR',true,'xxl') returning id into v_pkg;
  begin
    perform app.replace_dog_size_bands(v_org,'[
      {"key":"extra_small","label":"XS","upperKg":5},{"key":"small","label":"S","upperKg":10},
      {"key":"medium","label":"M","upperKg":15},{"key":"large","label":"L","upperKg":25.01},
      {"key":"extra_large","label":"XL","upperKg":null}]'::jsonb);
    raise exception 'active package allowed size deletion';
  exception when sqlstate '23514' then
    if sqlerrm<>'band_has_package' then raise; end if;
  end;
  update public.packages set is_active=false where id=v_pkg;
  perform app.replace_dog_size_bands(v_org,'[
      {"key":"extra_small","label":"XS","upperKg":5},{"key":"small","label":"S","upperKg":10},
      {"key":"medium","label":"M","upperKg":15},{"key":"large","label":"L","upperKg":25.01},
      {"key":"extra_large","label":"XL renamed","upperKg":null}]'::jsonb);
  if (select size from public.pets where id=v_pet)<>'extra_large'
     or (select label from public.organization_dog_size_bands where organization_id=v_org and key='extra_large')<>'XL renamed' then
    raise exception 'size delete/rename did not reclassify measured dog'; end if;
  raise notice 'PASS safe add, rename, delete and package guard';

  v_invoice:=app.create_invoice_from_manual_visit_lines(
    '0e000000-0000-4000-8000-0000000000f1',v_issued,v_due,
    '[{"name":"Basic Grooming Milo","quantity":1,"unitPrice":120000},{"name":"Transport","quantity":2,"unitPrice":15000}]'::jsonb,
    'Internal QC','0e000000-0000-4000-8000-0000000000f2');
  raise notice 'invoice subtotal %, total %, invoice lines %, order lines %', v_invoice.subtotal, v_invoice.total,
    (select count(*) from public.invoice_lines where invoice_id=v_invoice.id),
    (select count(*) from public.order_items where order_id=v_invoice.order_id);
  if v_invoice.total<>150000 or v_invoice.subtotal<>150000
     or (select count(*) from public.invoice_lines where invoice_id=v_invoice.id)<>2
     or (select count(*) from public.order_items where order_id=v_invoice.order_id)<>2 then
    raise exception 'multi-line invoice totals/rows failed'; end if;
  v_again:=app.create_invoice_from_manual_visit_lines(
    '0e000000-0000-4000-8000-0000000000f1',v_issued,v_due,
    '[{"name":"Basic Grooming Milo","quantity":1,"unitPrice":120000},{"name":"Transport","quantity":2,"unitPrice":15000}]'::jsonb,
    'Internal QC','0e000000-0000-4000-8000-0000000000f2');
  if v_again.id<>v_invoice.id then raise exception 'invoice retry duplicated'; end if;
  begin
    perform app.create_invoice_from_manual_visit_lines(
      '0e000000-0000-4000-8000-0000000000f1',v_issued,v_due,
      '[{"name":"Wrong total","quantity":1,"unitPrice":1}]'::jsonb,null,
      '0e000000-0000-4000-8000-0000000000f2');
    raise exception 'changed retry payload accepted';
  exception when sqlstate '22023' then
    if sqlerrm<>'request_key_reused' then raise; end if;
  end;
  begin
    perform app.create_invoice_from_manual_visit_lines(
      '0e000000-0000-4000-8000-0000000000f1',v_issued+interval '1 second',v_due,
      '[{"name":"Basic Grooming Milo","quantity":1,"unitPrice":120000},{"name":"Transport","quantity":2,"unitPrice":15000}]'::jsonb,
      'Internal QC','0e000000-0000-4000-8000-0000000000f2');
    raise exception 'changed retry issue date accepted';
  exception when sqlstate '22023' then
    if sqlerrm<>'request_key_reused' then raise; end if;
  end;
  begin
    perform app.create_invoice_from_manual_visit_lines(
      '0e000000-0000-4000-8000-0000000000f1',v_issued,v_due,
      '[{"name":"Basic Grooming Milo","quantity":1,"unitPrice":120000},{"name":"Transport","quantity":2,"unitPrice":15000}]'::jsonb,
      'Changed note','0e000000-0000-4000-8000-0000000000f2');
    raise exception 'changed retry admin note accepted';
  exception when sqlstate '22023' then
    if sqlerrm<>'request_key_reused' then raise; end if;
  end;
  raise notice 'PASS multi-line invoice, total, exact retry and immutable payload guard';

  perform set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-000000000099','role','authenticated','active_org_id',v_org)::text,true);
  begin
    perform app.replace_dog_size_bands(v_org,'[{"key":"all","label":"All","upperKg":null}]'::jsonb);
    raise exception 'non-member changed size bands';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform app.create_invoice_from_manual_visit_lines(
      '0e000000-0000-4000-8000-0000000000f1',v_issued,v_due,
      '[{"name":"Unauthorized","quantity":1,"unitPrice":1}]'::jsonb,null,
      '0e000000-0000-4000-8000-0000000000f3');
    raise exception 'non-member issued invoice';
  exception when sqlstate '42501' then null;
  end;
  perform set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id',v_org)::text,true);
  begin
    perform app.replace_dog_size_bands('0e000000-0000-4000-8000-000000000002','[{"key":"all","label":"All","upperKg":null}]'::jsonb);
    raise exception 'owner changed another tenant size bands';
  exception when sqlstate '42501' then null;
  end;
  raise notice 'PASS lower-role and cross-tenant guards';
end $$;
rollback;
