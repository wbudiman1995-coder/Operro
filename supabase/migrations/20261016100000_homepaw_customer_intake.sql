-- Narrow public onboarding access and transactional staff household creation.
-- Anonymous visitors are NOT granted USAGE on the entire app schema.
begin;

-- Existing onboarding submissions install the standard audit-column trigger,
-- but the table was created without its two audit columns. Every submit raised
-- "record new has no field created_by" before it could reach the admin queue.
alter table public.customer_onboarding_submissions
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;

create or replace function public.get_customer_onboarding_link(p_token text)
returns table(valid boolean, status text, expires_at timestamptz, organization_name text, organization_id uuid)
language sql volatile security definer set search_path = '' as $$
  select (l.status = 'active' and l.expires_at > now()),
         case when l.expires_at <= now() and l.status = 'active' then 'expired' else l.status end,
         l.expires_at, o.name, l.organization_id
  from public.customer_onboarding_links l
  join public.organizations o on o.id = l.organization_id
  where l.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  limit 1
$$;
create or replace function public.submit_customer_onboarding(p_token text, p_payload jsonb)
returns uuid language sql volatile security definer set search_path = '' as $$
  select app.submit_customer_onboarding(p_token, p_payload)
$$;
revoke all on function public.get_customer_onboarding_link(text) from public;
revoke all on function public.submit_customer_onboarding(text,jsonb) from public;
grant execute on function public.get_customer_onboarding_link(text) to anon, authenticated;
grant execute on function public.submit_customer_onboarding(text,jsonb) to anon, authenticated;

-- A visitor who is already signed in to Operro still needs to upload to a
-- token-scoped onboarding link. The same path/token check applies to both roles.
create policy onboarding_styling_authenticated_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'onboarding-styling'
  and app.can_upload_onboarding_style((storage.foldername(name))[1], (storage.foldername(name))[2])
);

create or replace function app.create_customer_household(
  p_name text, p_phone text, p_pets jsonb, p_address jsonb default null
) returns uuid language plpgsql security definer set search_path = pg_catalog as $$
declare
  v_org uuid := app.fn_active_organization();
  v_customer uuid;
  v_pet jsonb;
  v_weight numeric;
begin
  if v_org is null or not app.has_permission('customer.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 or coalesce(jsonb_typeof(p_pets),'') <> 'array' then
    raise exception 'invalid_household' using errcode = '22023';
  end if;
  if jsonb_array_length(p_pets) not between 1 and 5 then
    raise exception 'invalid_household' using errcode = '22023';
  end if;
  for v_pet in select value from jsonb_array_elements(p_pets) loop
    if length(trim(coalesce(v_pet->>'name', ''))) < 1
       or coalesce(v_pet->>'species','') not in ('dog', 'cat')
       or (v_pet->>'size' is not null and v_pet->>'size' not in ('small','medium','large','extra_large')) then
      raise exception 'invalid_pet' using errcode = '22023';
    end if;
  end loop;
  if p_address is not null and (
    jsonb_typeof(p_address) <> 'object' or length(trim(coalesce(p_address->>'line1',''))) < 1
    or length(trim(coalesce(p_address->>'province',''))) < 1
    or length(trim(coalesce(p_address->>'kabupaten_kota',''))) < 1
    or length(trim(coalesce(p_address->>'kecamatan',''))) < 1
  ) then
    raise exception 'invalid_address' using errcode = '22023';
  end if;

  insert into public.customers (organization_id,display_name,phone,status,source,metadata)
  values (v_org,left(trim(p_name),120),nullif(left(trim(coalesce(p_phone,'')),40),''),'active','Operro',jsonb_build_object('created_from','homepaw_pilot'))
  returning id into v_customer;

  for v_pet in select value from jsonb_array_elements(p_pets) loop
    begin
      v_weight := nullif(v_pet->>'weightKg','')::numeric;
    exception when invalid_text_representation then
      raise exception 'invalid_pet_weight' using errcode = '22023';
    end;
    if v_weight is not null and (v_weight <= 0 or v_weight > 999) then
      raise exception 'invalid_pet_weight' using errcode = '22023';
    end if;
    insert into public.pets (organization_id,customer_id,name,species,breed,size,weight_kg,color,notes,status,metadata)
    values (v_org,v_customer,left(trim(v_pet->>'name'),80),v_pet->>'species',nullif(left(trim(coalesce(v_pet->>'breed','')),100),''),
      nullif(v_pet->>'size',''),v_weight,nullif(left(trim(coalesce(v_pet->>'color','')),80),''),
      nullif(left(trim(coalesce(v_pet->>'notes','')),1000),''),'active',
      jsonb_build_object('created_from','homepaw_pilot','stated_age',coalesce(v_pet->>'age','')));
  end loop;

  if p_address is not null then
    insert into public.customer_addresses (
      organization_id,customer_id,label,recipient_name,recipient_phone,line1,line2,rt,rw,kelurahan,
      kecamatan,kabupaten_kota,province,postal_code,landmark,access_notes,latitude,longitude,is_default
    ) values (
      v_org,v_customer,coalesce(nullif(left(p_address->>'label',60),''),'Rumah'),nullif(left(p_address->>'recipient_name',120),''),
      nullif(left(p_address->>'recipient_phone',40),''),left(trim(p_address->>'line1'),200),nullif(left(p_address->>'line2',200),''),
      nullif(left(p_address->>'rt',10),''),nullif(left(p_address->>'rw',10),''),nullif(left(p_address->>'kelurahan',100),''),
      left(p_address->>'kecamatan',100),left(p_address->>'kabupaten_kota',100),left(p_address->>'province',100),
      nullif(left(p_address->>'postal_code',10),''),nullif(left(p_address->>'landmark',200),''),nullif(left(p_address->>'access_notes',500),''),
      nullif(p_address->>'latitude','')::numeric,nullif(p_address->>'longitude','')::numeric,true
    );
  end if;
  return v_customer;
end $$;
revoke all on function app.create_customer_household(text,text,jsonb,jsonb) from public;
grant execute on function app.create_customer_household(text,text,jsonb,jsonb) to authenticated;

create or replace function app.review_customer_onboarding(p_submission uuid,p_decision text,p_merge_customer uuid default null)
returns uuid language plpgsql security definer set search_path=app,public as $$
declare
  v_org uuid:=app.fn_active_organization(); v_sub public.customer_onboarding_submissions;
  v_link public.customer_onboarding_links; v_customer uuid; v_pet jsonb; v_pet_id uuid;
  v_ref jsonb; v_payload jsonb; v_lat numeric; v_lng numeric; v_client_pet_id text;
  v_path text; v_mime text; v_size bigint; v_expires timestamptz:=now()+interval '180 days';
begin
  if v_org is null or not app.has_permission('customer.manage') then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_decision not in ('approve','reject') then raise exception 'invalid_decision' using errcode='22023'; end if;
  select * into v_sub from public.customer_onboarding_submissions where organization_id=v_org and id=p_submission and status='submitted' for update;
  if not found then raise exception 'submission_not_found' using errcode='P0002'; end if;
  select * into v_link from public.customer_onboarding_links where organization_id=v_org and id=v_sub.link_id for update;
  if p_decision='reject' then
    update public.customer_onboarding_submissions set status='rejected',reviewed_at=now(),reviewed_by=auth.uid() where id=v_sub.id;
    update public.customer_onboarding_links set status='rejected' where id=v_link.id; return null;
  end if;
  v_payload:=v_sub.payload;
  if p_merge_customer is not null then
    select id into v_customer from public.customers where organization_id=v_org and id=p_merge_customer and deleted_at is null;
    if not found then raise exception 'merge_customer_not_found' using errcode='P0002'; end if;
  else
    insert into public.customers(organization_id,display_name,phone,status,source,notes,metadata)
    values(v_org,left(trim(v_payload->>'customerName'),120),left(trim(v_payload->>'phone'),40),'active',coalesce(v_link.source,'Self onboarding'),left(v_payload->>'customerNotes',2000),jsonb_build_object('created_from','self_onboarding','onboarding_submission_id',v_sub.id)) returning id into v_customer;
  end if;
  for v_pet in select value from jsonb_array_elements(v_payload->'pets') loop
    v_client_pet_id:=left(coalesce(v_pet->>'clientId',''),80);
    insert into public.pets(organization_id,customer_id,name,species,breed,size,weight_kg,color,notes,status,metadata)
    values(v_org,v_customer,left(trim(v_pet->>'name'),80),case when v_pet->>'species'='cat' then 'cat' else 'dog' end,left(nullif(trim(v_pet->>'breed'),''),100),nullif(v_pet->>'size',''),nullif(v_pet->>'weightKg','')::numeric,left(nullif(trim(v_pet->>'color'),''),80),left(nullif(trim(v_pet->>'notes'),''),1000),'active',jsonb_build_object('created_from','self_onboarding','stated_age',coalesce(v_pet->>'age',''),'onboarding_submission_id',v_sub.id,'client_pet_id',v_client_pet_id)) returning id into v_pet_id;
    if jsonb_typeof(v_pet->'styleReferences')='array' and jsonb_array_length(v_pet->'styleReferences')<=2 then
      for v_ref in select value from jsonb_array_elements(v_pet->'styleReferences') loop
        v_path:=coalesce(v_ref->>'path',''); v_mime:=coalesce(v_ref->>'mimeType','');
        begin v_size:=(v_ref->>'sizeBytes')::bigint; exception when others then v_size:=0; end;
        if v_client_pet_id<>''
           and v_path like v_org::text||'/'||v_link.token_hash||'/'||v_client_pet_id||'/%'
           and v_mime in ('image/jpeg','image/png','image/webp') and v_size between 1 and 1572864
           and exists(select 1 from storage.objects where bucket_id='onboarding-styling' and name=v_path) then
          with inserted as (
            insert into public.attachments(organization_id,storage_bucket,storage_path,filename,mime_type,size_bytes,metadata)
            values(v_org,'onboarding-styling',v_path,left(coalesce(nullif(v_ref->>'filename',''),'referensi'),200),v_mime,v_size,jsonb_build_object('kind','styling_reference','customer_id',v_customer,'pet_id',v_pet_id,'caption',left(coalesce(v_ref->>'caption',''),300),'expires_at',v_expires,'onboarding_submission_id',v_sub.id))
            returning id
          )
          insert into public.attachment_links(organization_id,attachment_id,subject_type,subject_id)
          select v_org,id,'pet',v_pet_id from inserted;
        end if;
      end loop;
    end if;
  end loop;
  if p_merge_customer is null and length(trim(coalesce(v_payload->>'addressLine','')))>0 then
    begin v_lat:=nullif(v_payload->>'latitude','')::numeric; v_lng:=nullif(v_payload->>'longitude','')::numeric; exception when others then v_lat:=null;v_lng:=null; end;
    insert into public.customer_addresses(organization_id,customer_id,label,recipient_name,recipient_phone,line1,line2,rt,rw,kelurahan,kecamatan,kabupaten_kota,province,postal_code,landmark,access_notes,latitude,longitude,is_default)
    values(v_org,v_customer,coalesce(nullif(left(v_payload->>'addressLabel',60),''),'Rumah'),coalesce(nullif(left(v_payload->>'recipientName',120),''),left(v_payload->>'customerName',120)),coalesce(nullif(left(v_payload->>'recipientPhone',40),''),left(v_payload->>'phone',40)),left(v_payload->>'addressLine',200),nullif(left(v_payload->>'addressLine2',200),''),nullif(left(v_payload->>'rt',10),''),nullif(left(v_payload->>'rw',10),''),nullif(left(v_payload->>'kelurahan',100),''),left(nullif(v_payload->>'kecamatan',''),100),left(nullif(v_payload->>'kabupatenKota',''),100),left(nullif(v_payload->>'province',''),100),nullif(left(v_payload->>'postalCode',10),''),nullif(left(v_payload->>'landmark',200),''),nullif(left(v_payload->>'accessNotes',500),''),case when abs(v_lat)<=90 then v_lat end,case when abs(v_lng)<=180 then v_lng end,true);
  end if;
  update public.customer_onboarding_submissions set status='approved',reviewed_at=now(),reviewed_by=auth.uid(),merged_customer_id=v_customer where id=v_sub.id;
  update public.customer_onboarding_links set status='approved' where id=v_link.id;
  return v_customer;
end $$;

-- Historical coverage zones may say "Jakarta Selatan" while the official
-- selector says "Kota Administrasi Jakarta Selatan". Accept that one prefix
-- variation without collapsing unrelated Kota/Kabupaten names elsewhere.
create or replace function app.fn_check_service_area(
  p_branch uuid, p_kecamatan text, p_kabupaten_kota text
) returns table (allowed boolean, travel_fee numeric, estimated_travel_minutes integer, matched_zone text)
language plpgsql stable security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_configured integer;
  v_match record;
begin
  if not app.has_membership() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select count(*) into v_configured from public.branch_service_areas
  where organization_id = v_org and branch_id = p_branch and is_active and deleted_at is null;
  if v_configured = 0 then return query select true, 0::numeric, 0, null::text; return; end if;

  select sa.travel_fee, sa.estimated_travel_minutes, sa.kecamatan, sa.kabupaten_kota into v_match
  from public.branch_service_areas sa
  where sa.organization_id = v_org and sa.branch_id = p_branch and sa.is_active and sa.deleted_at is null
    and lower(trim(regexp_replace(sa.kabupaten_kota, '^(Kota|Kabupaten) Administrasi\s+', '', 'i')))
        = lower(trim(regexp_replace(p_kabupaten_kota, '^(Kota|Kabupaten) Administrasi\s+', '', 'i')))
    and (sa.kecamatan is null or lower(trim(sa.kecamatan)) = lower(trim(p_kecamatan)))
  order by (sa.kecamatan is not null) desc
  limit 1;
  if v_match is null then return query select false, null::numeric, null::integer, null::text;
  else return query select true, v_match.travel_fee, v_match.estimated_travel_minutes,
    coalesce(v_match.kecamatan, v_match.kabupaten_kota);
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
