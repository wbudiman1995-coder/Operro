-- Run only against a disposable database after applying every migration and
-- integration/0100_integration_seed.sql. Exercises authenticated package
-- issuance/idempotency and discounted visit invoicing with a transport fee.
insert into public.role_permissions(organization_id,role_id,permission_id)
select '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000e1',p.id
from public.permissions p where p.key in ('invoice.issue','finance.read','membership.manage','service.manage')
on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
select '0e000000-0000-4000-8000-000000000001',m.id,true
from public.modules m where m.key in ('finance','pos','membership')
on conflict(organization_id,module_id) do update set enabled=true;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object(
  'sub','0e000000-0000-4000-8000-0000000000c1',
  'role','authenticated',
  'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$
declare first_invoice public.invoices; second_invoice public.invoices; v_key uuid:='0e000000-0000-4000-8000-00000000af01';
begin
  first_invoice:=app.create_package_invoice(
    '0e000000-0000-4000-8000-0000000000a1',
    '0e000000-0000-4000-8000-0000000000f0',
    '0e000000-0000-4000-8000-00000000a001',
    now(),now()+interval '1 day',null,v_key);
  second_invoice:=app.create_package_invoice(
    '0e000000-0000-4000-8000-0000000000a1',
    '0e000000-0000-4000-8000-0000000000f0',
    '0e000000-0000-4000-8000-00000000a001',
    now(),now()+interval '1 day',null,v_key);
  if first_invoice.id is distinct from second_invoice.id then raise exception 'package idempotency failed'; end if;
  if not exists(select 1 from public.invoice_lines where invoice_id=first_invoice.id and item_type='package' and package_id='0e000000-0000-4000-8000-00000000a001') then raise exception 'package invoice line missing'; end if;
  if not exists(select 1 from public.customer_packages where metadata->>'source_invoice_id'=first_invoice.id::text and sessions_remaining=3) then raise exception 'package balance missing'; end if;
  raise notice 'PASS package invoice, idempotency, package line, and 3-session balance';
end $$;
commit;

select set_config('request.jwt.claims',json_build_object(
  'sub','0e000000-0000-4000-8000-0000000000c1',
  'role','authenticated',
  'active_org_id','0e000000-0000-4000-8000-000000000001')::text,false);
insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at,fulfillment_mode,travel_fee)
values('0e000000-0000-4000-8000-00000000ba02','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000a1','0e000000-0000-4000-8000-0000000000f0','grooming','completed',now()-interval '1 hour',now(),'home',20);
insert into public.grooming_jobs(booking_id,organization_id)
values('0e000000-0000-4000-8000-00000000ba02','0e000000-0000-4000-8000-000000000001');
insert into public.grooming_job_pets(id,organization_id,grooming_job_id,pet_id,status,sequence)
values('0e000000-0000-4000-8000-00000000be02','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-00000000ba02','0e000000-0000-4000-8000-0000000000f1','complete',1);
insert into public.grooming_job_pet_services(id,organization_id,grooming_job_pet_id,service_id,service_name_snapshot,quantity,unit_price_snapshot,currency)
values('0e000000-0000-4000-8000-00000000fe02','0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-00000000be02','0e000000-0000-4000-8000-000000005001','Bath',2,100,'IDR');

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object(
  'sub','0e000000-0000-4000-8000-0000000000c1',
  'role','authenticated',
  'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$
declare v_preview jsonb; v_invoice_id uuid; v_row public.invoices; v_line_count integer;
begin
  v_preview:=app.preview_invoice_pricing('0e000000-0000-4000-8000-00000000ba02','{"type":"percent","value":10}'::jsonb,'[]','[]','[]');
  if (v_preview->>'total')::numeric <> 200 then raise exception 'preview total mismatch: %',v_preview; end if;
  v_invoice_id:=app.issue_invoice_for_booking('0e000000-0000-4000-8000-00000000ba02',
    '{"type":"percent","value":10}'::jsonb,'[]','[]','[]',now(),now()+interval '1 day','invoice',null,'Alex','internal test');
  select * into v_row from public.invoices where id=v_invoice_id;
  if v_row.total <> 200 or v_row.discount_total <> 20 or v_row.groomer_name_snapshot <> 'Alex' then raise exception 'issued invoice mismatch: %',row_to_json(v_row); end if;
  select count(*) into v_line_count from public.invoice_lines where invoice_id=v_invoice_id;
  if v_line_count <> 2 or not exists(select 1 from public.invoice_lines where invoice_id=v_invoice_id and item_type='fee' and line_total=20) then raise exception 'transport fee line missing'; end if;
  raise notice 'PASS preview and issued total=200, discount=20, transport fee=20, manual groomer';
end $$;
commit;
