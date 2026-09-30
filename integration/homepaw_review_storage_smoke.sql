\set ON_ERROR_STOP on
-- Run after homepaw_qc_smoke.sql in a disposable PostgreSQL 16 database.
insert into public.role_permissions(organization_id,role_id,permission_id)
select '0e000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000e1',id
from public.permissions where key='settings.manage' on conflict do nothing;
insert into public.customer_onboarding_links(organization_id,token_hash,source)
values ('0e000000-0000-4000-8000-000000000001',encode(extensions.digest('amend-qc-token','sha256'),'hex'),'QC amend');
insert into public.customer_onboarding_submissions(organization_id,link_id,payload)
select organization_id,id,'{"customerName":"Before Fix","phone":"081298765432","addressLine":"Jalan 1","googleMapsUrl":"https://maps.app.goo.gl/example","province":"DKI Jakarta","kabupatenKota":"Kota Administrasi Jakarta Selatan","kecamatan":"Kebayoran Baru","pets":[{"clientId":"pet-1","name":"Milo","species":"dog","weightKg":"4.500","styleReferences":[]}]}'::jsonb
from public.customer_onboarding_links where token_hash=encode(extensions.digest('amend-qc-token','sha256'),'hex');
insert into storage.objects(id,bucket_id,name,metadata) values
('0e000000-0000-4000-8000-00000000f001','attachments','0e000000-0000-4000-8000-000000000001/photo.jpg','{"size":1024}'),
('0e000000-0000-4000-8000-00000000f002','attachments','0e000000-0000-4000-8000-000000000099/photo.jpg','{"size":2048}');

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_id uuid; v_before timestamptz; v_payload jsonb; v_usage jsonb; begin
  select s.id,s.updated_at into v_id,v_before from public.customer_onboarding_submissions s
    join public.customer_onboarding_links l on l.id=s.link_id where l.source='QC amend';
  select payload into v_payload from public.customer_onboarding_submissions where id=v_id;
  perform app.amend_customer_onboarding(v_id,jsonb_set(v_payload,'{customerName}','"After Fix"'),v_before);
  if (select payload->>'customerName' from public.customer_onboarding_submissions where id=v_id) <> 'After Fix' then raise exception 'amend did not persist'; end if;
  begin
    perform app.amend_customer_onboarding(v_id,v_payload,v_before);
    raise exception 'stale amendment succeeded';
  exception when sqlstate '40001' then null;
  end;
  v_usage := app.storage_usage_snapshot();
  if (v_usage->>'organization_file_bytes')::bigint <> 1024 or v_usage->>'project_file_bytes' is not null then
    raise exception 'tenant storage leaked other org: %',v_usage;
  end if;
  insert into public.storage_upgrade_requests(organization_id,requested_gb,created_by)
    values ('0e000000-0000-4000-8000-000000000001',5,'0e000000-0000-4000-8000-0000000000c1');
  begin
    insert into public.storage_upgrade_requests(organization_id,requested_gb,created_by)
      values ('0e000000-0000-4000-8000-000000000001',10,'0e000000-0000-4000-8000-0000000000c1');
    raise exception 'duplicate open request succeeded';
  exception when unique_violation then null;
  end;
  if app.review_customer_onboarding(v_id,'approve',null) is null then raise exception 'approval returned no customer'; end if;
  raise notice 'PASS authenticated amend, stale guard, approval and tenant storage/request isolation';
end $$;
commit;
do $$ begin
  if not exists(select 1 from public.customers where organization_id='0e000000-0000-4000-8000-000000000001' and display_name='After Fix' and phone='081298765432') then
    raise exception 'approval did not use amended payload';
  end if;
  if not exists(select 1 from public.customer_addresses a join public.customers c on c.id=a.customer_id
    where c.display_name='After Fix' and a.google_maps_url='https://maps.app.goo.gl/example') then
    raise exception 'Google Maps link was lost on approval';
  end if;
  raise notice 'PASS approved customer uses amended payload';
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated','active_org_id','0e000000-0000-4000-8000-000000000099')::text,true);
do $$ declare v_id uuid; v_time timestamptz; begin
  select s.id,s.updated_at into v_id,v_time from public.customer_onboarding_submissions s
    join public.customer_onboarding_links l on l.id=s.link_id where l.source='QC amend';
  begin
    perform app.amend_customer_onboarding(v_id,'{}'::jsonb,v_time);
    raise exception 'cross-org amendment succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app.storage_usage_snapshot();
    raise exception 'cross-org usage succeeded';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS cross-org amendment and usage denied';
end $$;
rollback;
