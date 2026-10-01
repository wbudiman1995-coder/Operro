\set ON_ERROR_STOP on
insert into auth.users(id,email,email_confirmed_at) values
('a1000000-0000-4000-8000-000000000002','owner@example.test',now()),
('a1000000-0000-4000-8000-000000000003','helper@example.test',now()),
('a1000000-0000-4000-8000-000000000004','wrong@example.test',now()),
('a1000000-0000-4000-8000-000000000005','admin@example.test',now()),
('a1000000-0000-4000-8000-000000000006','groomer@example.test',now());
do $$ begin
  if not exists(select 1 from public.users where email='wbudiman1995@gmail.com' and is_platform_admin and status='active')
    then raise exception 'existing Operro owner was not bootstrapped'; end if;
  raise notice 'PASS existing Operro owner platform flag bootstrapped';
end $$;
create temporary table qc_tokens(email text primary key, token text not null);
grant select, insert on qc_tokens to authenticated;
create temporary table qc_org(id uuid primary key);
grant select, insert on qc_org to authenticated;
do $$ begin
  if not exists(select 1 from public.organizations o join public.roles r on r.organization_id=o.id
    where o.slug='legacy-qc' and r.name='Admin') then raise exception 'legacy Admin role not backfilled'; end if;
  if not exists(select 1 from public.organizations o join public.roles r on r.organization_id=o.id
    where o.slug='legacy-qc' and r.name='Pemilik') then raise exception 'legacy Pemilik role not backfilled'; end if;
  raise notice 'PASS legacy organization invitation roles backfilled';
end $$;
do $$ begin
  if has_table_privilege('authenticated','public.memberships','INSERT')
    or has_table_privilege('authenticated','public.memberships','UPDATE')
    or has_table_privilege('authenticated','public.role_permissions','INSERT')
    or has_table_privilege('authenticated','public.role_permissions','DELETE')
    or has_table_privilege('authenticated','public.subscriptions','UPDATE')
    or has_table_privilege('authenticated','public.organizations','UPDATE')
  then raise exception 'direct protected-table write still granted'; end if;
  raise notice 'PASS direct membership, role, billing and org-status writes revoked';
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000001','role','authenticated','app_metadata',json_build_object('is_platform_admin',true))::text,true);
do $$ declare v_org uuid; begin
  if not app.is_operro_owner() then raise exception 'platform owner not recognized'; end if;
  if app.is_business_owner_member((select id from public.organizations where slug='legacy-qc')) then
    raise exception 'platform owner gained business-only checklist access'; end if;
  if jsonb_array_length(app.list_organization_access((select id from public.organizations where slug='legacy-qc'))->'options')<>0
    or jsonb_array_length(app.list_organization_access((select id from public.organizations where slug='legacy-qc'))->'admin_keys')<>0
  then raise exception 'platform owner can read business Admin checklist'; end if;
  begin
    perform app.set_business_admin_permissions((select id from public.organizations where slug='legacy-qc'),array['booking.read']);
    raise exception 'platform owner edited business Admin checklist';
  exception when insufficient_privilege then null; end;
  insert into qc_tokens values('legacy-invite@example.test',app.issue_access_invitation(
    (select id from public.organizations where slug='legacy-qc'),'legacy-invite@example.test','Admin'));
  v_org:=app.prepare_operro_organization('QC Grooming','qc-grooming');
  insert into qc_org values(v_org);
  if not exists(select 1 from public.branches where organization_id=v_org and is_default) then raise exception 'default branch missing'; end if;
  insert into qc_tokens values('owner@example.test',app.issue_access_invitation(v_org,'owner@example.test','Pemilik'));
  insert into qc_tokens values('helper@example.test',app.issue_access_invitation(v_org,'helper@example.test','Bantuan Operro'));
  insert into qc_tokens values('admin@example.test',app.issue_access_invitation(v_org,'admin@example.test','Admin'));
  insert into qc_tokens values('groomer@example.test',app.issue_access_invitation(v_org,'groomer@example.test','Groomer'));
  perform app.set_operro_billing_period(v_org,date '2026-09-01',250000,date '2026-09-30','awaiting_payment','QC manual invoice');
  if (app.list_operro_billing(v_org)->0->>'status') <> 'awaiting_payment' then raise exception 'billing record missing'; end if;
  if app.issue_operro_invoice(v_org,date '2026-09-01','Langganan Operro September')
    <> app.issue_operro_invoice(v_org,date '2026-09-01','Langganan Operro September')
  then raise exception 'invoice retry was not idempotent'; end if;
  begin
    perform app.set_operro_billing_period(v_org,date '2026-09-01',300000,date '2026-09-30','awaiting_payment',null);
    raise exception 'issued invoice amount was changed';
  exception when check_violation then null; end;
  if app.list_operro_billing(v_org)->0->>'invoice_number' not like 'OPR-%'
  then raise exception 'platform invoice missing from billing list'; end if;
  raise notice 'PASS platform owner provisioned organization, branch, subscription, roles and invites';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000004','role','authenticated')::text,true);
do $$ begin
  begin
    perform app.claim_access_invitation((select token from qc_tokens where email='owner@example.test'));
    raise exception 'wrong-email claim succeeded';
  exception when insufficient_privilege then null; end;
  begin
    perform app.prepare_operro_organization('Unauthorized','unauthorized');
    raise exception 'non-owner provision succeeded';
  exception when insufficient_privilege then null; end;
  begin
    perform app.list_operro_billing((select id from qc_org));
    raise exception 'non-owner read platform billing';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS wrong email and non-owner rejected';
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000002','role','authenticated')::text,true);
do $$ declare v_org uuid; begin
  v_org:=app.claim_access_invitation((select token from qc_tokens where email='owner@example.test'));
  perform set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000002','role','authenticated','active_org_id',v_org)::text,true);
  if not app.is_business_owner(v_org) then raise exception 'business owner missing'; end if;
  perform app.set_org_pet_type(v_org,'rabbit','Kelinci',true);
  if (select count(*) from jsonb_array_elements(app.list_my_operro_invoices()))<>1
    or app.get_operro_invoice((app.list_my_operro_invoices()->0->>'id')::uuid)->>'organization_name'<>'QC Grooming'
  then raise exception 'business owner cannot read their platform invoice'; end if;
  begin
    perform app.issue_access_invitation(v_org,'new@example.test','Admin');
    raise exception 'business owner issued forbidden invitation';
  exception when insufficient_privilege then null; end;
  perform app.set_business_admin_permissions(v_org,array['booking.read','customer.read']);
  perform app.set_dog_size_boundaries(v_org,6,11,16,26);
  insert into public.customers(organization_id,display_name,status) values(v_org,'QC Customer','active');
  insert into public.pets(organization_id,customer_id,name,species,weight_kg,status)
    select v_org,id,'QC Dog','dog',5.5,'active' from public.customers where organization_id=v_org and display_name='QC Customer';
  if not exists(select 1 from public.pets where organization_id=v_org and name='QC Dog' and size='extra_small') then raise exception 'pet trigger missed org cutoff'; end if;
  raise notice 'PASS owner claimed, Admin checklist saved, custom dog-size cutoff applied';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000003','role','authenticated')::text,true);
do $$ declare v_org uuid; begin
  v_org:=app.claim_access_invitation((select token from qc_tokens where email='helper@example.test'));
  perform set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000003','role','authenticated','active_org_id',v_org)::text,true);
  if not app.has_permission('booking.read') or app.has_permission('payroll.read') or app.has_permission('payroll.manage') or app.has_permission('payroll.approve') or app.has_permission('finance.read') or app.has_permission('reports.view') then
    raise exception 'helper permission boundary failed'; end if;
  if exists(select 1 from app.list_my_permissions() where perm like 'payroll.%') then raise exception 'batch permission leaked payroll'; end if;
  begin
    perform app.set_dog_size_boundaries(v_org,7,12,17,27);
    raise exception 'helper changed business size cutoffs';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS helper sees operations but no payroll and cannot change owner settings';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000006','role','authenticated')::text,true);
do $$ declare v_org uuid; v_member uuid; v_branch uuid; begin
  v_org:=app.claim_access_invitation((select token from qc_tokens where email='groomer@example.test'));
  perform set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000006','role','authenticated','active_org_id',v_org)::text,true);
  if app.has_branch((select id from public.branches where organization_id=v_org and is_default)) then
    raise exception 'unlinked groomer sees whole branch'; end if;
  if jsonb_array_length(app.list_my_operro_invoices())<>0 then
    raise exception 'groomer can enumerate business subscription invoices'; end if;
  raise notice 'PASS groomer requires linked staff resource for branch access';
end $$;
commit;

-- Resource linking is performed by a business manager; its trigger grants the
-- invited groomer access to the assigned branch without branches.all.
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000002','role','authenticated','active_org_id',(select id from qc_org))::text,true);
insert into public.resources(organization_id,branch_id,membership_id,kind,name,status)
select o.id,b.id,m.id,'staff','QC Groomer','active' from qc_org o
join public.branches b on b.organization_id=o.id and b.is_default
join public.memberships m on m.organization_id=o.id and m.user_id='a1000000-0000-4000-8000-000000000006';
commit;

begin;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000001','role','authenticated','app_metadata',json_build_object('is_platform_admin',true))::text,true);
insert into public.customers(organization_id,display_name,status) select id,'QC Other','active' from qc_org;
insert into public.pets(organization_id,customer_id,name,species,weight_kg,status)
select c.organization_id,c.id,'QC Other Dog','dog',9,'active' from public.customers c where c.display_name='QC Other';
insert into public.bookings(organization_id,branch_id,customer_id,booking_type,starts_at,ends_at)
select c.organization_id,b.id,c.id,'grooming',now()+interval '1 day',now()+interval '1 day 1 hour'
from public.customers c join public.branches b on b.organization_id=c.organization_id and b.is_default
where c.organization_id=(select id from qc_org) and c.display_name in ('QC Customer','QC Other');
insert into public.grooming_jobs(organization_id,booking_id)
select b.organization_id,b.id from public.bookings b join public.customers c on c.id=b.customer_id
where b.organization_id=(select id from qc_org) and c.display_name='QC Customer';
insert into public.grooming_job_pets(organization_id,grooming_job_id,pet_id,assigned_resource_id)
select b.organization_id,b.id,p.id,r.id from public.bookings b
join public.customers c on c.id=b.customer_id join public.pets p on p.customer_id=c.id
join public.resources r on r.organization_id=b.organization_id and r.name='QC Groomer'
where b.organization_id=(select id from qc_org) and c.display_name='QC Customer';
insert into public.pets(organization_id,customer_id,name,species,status)
select id,(select id from public.customers where organization_id=o.id and display_name='QC Customer'),
  'QC Rabbit','rabbit','active' from public.organizations o where id=(select id from qc_org);
insert into public.service_catalog(organization_id,name,category,duration_minutes,base_price,currency,species_pricing)
select id,'QC Custom Species','Other Fees',60,50000,'IDR','{"rabbit":{"price":75000,"duration":45}}'::jsonb
from public.organizations where id=(select id from qc_org);
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000002','role','authenticated','active_org_id',(select id from qc_org))::text,true);
do $$ declare v_job_pet uuid; v_line uuid; begin
  v_job_pet:=app.assembly_add_pet((select b.id from public.bookings b join public.customers c on c.id=b.customer_id
    where c.organization_id=(select id from qc_org) and c.display_name='QC Customer' limit 1),
    (select id from public.pets where organization_id=(select id from qc_org) and name='QC Rabbit'),true);
  v_line:=app.assembly_add_line(v_job_pet,(select id from public.service_catalog where organization_id=(select id from qc_org) and name='QC Custom Species'),1);
  if not exists(select 1 from public.grooming_job_pet_services where id=v_line and unit_price_snapshot=75000 and duration_minutes=45 and pet_size_snapshot='rabbit') then
    raise exception 'custom pet type price/duration not snapshotted'; end if;
  raise notice 'PASS custom pet type uses explicit species price and duration in booking assembly';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000006','role','authenticated','active_org_id',(select id from qc_org))::text,true);
do $$ begin
  if not app.has_branch((select id from public.branches where organization_id=(select id from qc_org) and is_default)) then
    raise exception 'linked groomer cannot see branch'; end if;
  if (select count(*) from public.bookings where organization_id=(select id from qc_org))<>1
    or (select count(*) from public.customers where organization_id=(select id from qc_org))<>1
    or (select count(*) from public.pets where organization_id=(select id from qc_org))<>1
  then raise exception 'groomer can see unassigned customer, pet, or booking'; end if;
  raise notice 'PASS linked groomer sees assigned branch and only own customer, pet and booking';
end $$;
commit;

begin;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000001','role','authenticated','app_metadata',json_build_object('is_platform_admin',true))::text,true);
update public.resources set status='retired' where organization_id=(select id from qc_org) and name='QC Groomer';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000006','role','authenticated','active_org_id',(select id from qc_org))::text,true);
do $$ begin
  if app.has_branch((select id from public.branches where organization_id=(select id from qc_org) and is_default)) then
    raise exception 'retired resource retained groomer branch access'; end if;
  raise notice 'PASS retired resource removes groomer branch access';
end $$;
commit;
begin;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000001','role','authenticated','app_metadata',json_build_object('is_platform_admin',true))::text,true);
update public.users set status='deactivated' where id='a1000000-0000-4000-8000-000000000003';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000003','role','authenticated','active_org_id',(select id from qc_org))::text,true);
do $$ begin
  if app.has_membership() or app.has_permission('booking.read') then raise exception 'deactivated user retained access'; end if;
  raise notice 'PASS deactivated user loses live permissions despite stale token';
end $$;
commit;
begin;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000001','role','authenticated','app_metadata',json_build_object('is_platform_admin',true))::text,true);
update public.users set status='active' where id='a1000000-0000-4000-8000-000000000003';
commit;

begin;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000001','role','authenticated','app_metadata',json_build_object('is_platform_admin',true))::text,true);
insert into public.customer_onboarding_links(organization_id,token_hash,source)
values((select id from qc_org),encode(extensions.digest('qc-suspend-link','sha256'),'hex'),'QC');
insert into qc_tokens values('onboarding-hash',encode(extensions.digest('qc-suspend-link','sha256'),'hex'));
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000005','role','authenticated')::text,true);
do $$ declare v_org uuid; begin
  v_org:=app.claim_access_invitation((select token from qc_tokens where email='admin@example.test'));
  perform set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000005','role','authenticated','active_org_id',v_org)::text,true);
  if not app.has_permission('customer.read') or app.has_permission('payroll.read') then raise exception 'owner checklist ignored'; end if;
  raise notice 'PASS Admin receives owner-selected checklist';
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000001','role','authenticated','app_metadata',json_build_object('is_platform_admin',true))::text,true);
select app.set_operro_organization_status((select id from qc_org),'suspended','QC unpaid');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000003','role','authenticated','active_org_id',(select id from qc_org))::text,true);
do $$ begin
  if app.has_permission('booking.read') or app.has_membership() or exists(select 1 from app.list_my_permissions()) then
    raise exception 'stale token retained access to suspended org'; end if;
  if (select valid from public.get_customer_onboarding_link('qc-suspend-link')) then
    raise exception 'suspended org public registration remains valid'; end if;
  if app.can_upload_onboarding_style((select id::text from qc_org),(select token from qc_tokens where email='onboarding-hash')) then
    raise exception 'suspended org public upload remains valid'; end if;
  begin
    perform public.submit_customer_onboarding('qc-suspend-link','{"customerName":"QC Customer","phone":"08123456789","pets":[{"name":"QC Pet"}]}'::jsonb);
    raise exception 'suspended org accepted public submission';
  exception when no_data_found then null; end;
  raise notice 'PASS suspension revokes live authorization even on stale JWT';
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','a1000000-0000-4000-8000-000000000002','role','authenticated')::text,true);
do $$ begin
  if jsonb_array_length(app.list_my_operro_invoices())<>1 then
    raise exception 'suspended business owner cannot read unpaid invoice'; end if;
  raise notice 'PASS suspended business owner retains access to Operro invoice only';
end $$;
rollback;
