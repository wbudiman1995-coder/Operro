-- Tenant-defined pet species and per-service prices/durations. Dog size bands
-- and the existing Cat column stay compatible with all sold snapshots.
begin;

create table public.organization_pet_types (
  organization_id uuid not null references public.organizations(id),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,29}$'),
  label text not null check (length(btrim(label)) between 2 and 60),
  is_active boolean not null default true,
  primary key (organization_id,key)
);
insert into public.organization_pet_types(organization_id,key,label)
select o.id,t.key,t.label from public.organizations o
cross join (values ('dog','Anjing'),('cat','Kucing')) t(key,label)
where o.deleted_at is null;
create function app.seed_org_pet_types() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.organization_pet_types(organization_id,key,label)
  values(new.id,'dog','Anjing'),(new.id,'cat','Kucing')
  on conflict (organization_id,key) do nothing;
  return new;
end;
$$;
create trigger trg_seed_org_pet_types after insert on public.organizations
  for each row execute function app.seed_org_pet_types();
alter table public.organization_pet_types enable row level security;
grant select on public.organization_pet_types to authenticated;
create policy org_pet_types_read on public.organization_pet_types for select to authenticated
  using (app.is_operro_owner() or (organization_id=app.fn_active_organization() and app.has_membership()));

create function app.set_org_pet_type(p_org uuid,p_key text,p_label text,p_active boolean default true)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_org<>app.fn_active_organization() or not app.has_permission('service.manage') then
    raise exception 'not_authorized' using errcode='42501'; end if;
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]{1,29}$'
    or length(btrim(coalesce(p_label,''))) not between 2 and 60
    or (p_key in ('dog','cat') and not p_active) then
    raise exception 'invalid_pet_type' using errcode='22023'; end if;
  insert into public.organization_pet_types(organization_id,key,label,is_active)
  values(p_org,p_key,btrim(p_label),p_active)
  on conflict (organization_id,key) do update set label=excluded.label,is_active=excluded.is_active;
end;
$$;
revoke all on function app.set_org_pet_type(uuid,text,text,boolean) from public;
grant execute on function app.set_org_pet_type(uuid,text,text,boolean) to authenticated;

alter table public.service_catalog add column species_pricing jsonb not null default '{}'::jsonb;
alter table public.service_catalog add constraint chk_service_species_pricing_object
  check (jsonb_typeof(species_pricing)='object');

-- Historical intake payloads may carry a dog size for a cat. Preserve that
-- accepted input while keeping size meaningful only for dogs (including new
-- tenant-defined species).
create or replace function app.tg_homepaw_pet_size_from_weight() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if new.species <> 'dog' then
    new.size := null;
  elsif new.weight_kg is not null then
    new.size := app.dog_size_for_weight(new.organization_id,new.weight_kg);
  end if;
  return new;
end $$;
create function app.validate_service_species_pricing() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_key text; v_rule jsonb; v_price numeric; v_duration numeric;
begin
  for v_key,v_rule in select key,value from jsonb_each(new.species_pricing) loop
    if v_key in ('dog','cat') or not exists(select 1 from public.organization_pet_types t
      where t.organization_id=new.organization_id and t.key=v_key and t.is_active)
      or jsonb_typeof(v_rule)<>'object' or not (v_rule ? 'price') or not (v_rule ? 'duration')
      or jsonb_typeof(v_rule->'price')<>'number' or jsonb_typeof(v_rule->'duration')<>'number'
    then raise exception 'invalid_species_pricing' using errcode='22023'; end if;
    v_price:=(v_rule->>'price')::numeric;
    v_duration:=(v_rule->>'duration')::numeric;
    if v_price<0 or v_price>999999999 or v_duration<0 or v_duration>1440 or v_duration<>trunc(v_duration) then
      raise exception 'invalid_species_pricing' using errcode='22023'; end if;
  end loop;
  return new;
end;
$$;
create trigger trg_validate_service_species_pricing before insert or update of species_pricing
  on public.service_catalog for each row execute function app.validate_service_species_pricing();

alter table public.grooming_job_pet_services drop constraint chk_gjps_pet_size_snapshot;
alter table public.grooming_job_pet_services add constraint chk_gjps_pet_size_snapshot
  check (pet_size_snapshot is null or pet_size_snapshot ~ '^[a-z][a-z0-9_]{1,29}$');

-- The authoritative booking-assembly function is replaced below, using the
-- final definition from 20261019110000 and adding custom-species lookup.

create or replace function app.assembly_add_line(p_pet uuid, p_service uuid, p_quantity integer default 1)
returns uuid security definer set search_path = app, public language plpgsql as $$
declare gjp record; b public.bookings; v_job uuid;
        v_price numeric(14,2); v_name text; v_cur text; v_dur integer; v_id uuid;
        v_pet_size text; v_pet_species text; v_pet_weight numeric; v_size_price numeric(14,2); v_size_dur integer; v_extra_dur integer;
        v_final_price numeric(14,2); v_final_dur integer; v_source text;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity_must_be_positive' using errcode = 'check_violation'; end if;
  select grooming_job_id into v_job from public.grooming_job_pets where id = p_pet;
  if not found then raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select * into gjp from public.grooming_job_pets where id = p_pet for update;
  if not found or gjp.deleted_at is not null then
    raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;

  select pt.species, pt.size, pt.weight_kg into v_pet_species, v_pet_size, v_pet_weight
  from public.pets pt where pt.organization_id = gjp.organization_id and pt.id = gjp.pet_id;
  if v_pet_species = 'cat' then
    v_pet_size := 'cat';
  elsif v_pet_species = 'dog' then
    v_pet_size := coalesce(app.dog_size_for_weight(gjp.organization_id, v_pet_weight), v_pet_size);
  else
    v_pet_size := v_pet_species;
  end if;

  select sc.name, sc.base_price, sc.currency, sc.duration_minutes, sc.additional_duration_minutes,
         case v_pet_size
           when 'extra_small' then sc.price_extra_small
           when 'small' then sc.price_small
           when 'medium' then sc.price_medium
           when 'large' then sc.price_large
           when 'extra_large' then sc.price_extra_large
           when 'cat' then sc.price_cat
           else (sc.species_pricing->v_pet_species->>'price')::numeric end,
         case v_pet_size
           when 'extra_small' then sc.duration_extra_small
           when 'small' then sc.duration_small
           when 'medium' then sc.duration_medium
           when 'large' then sc.duration_large
           when 'extra_large' then sc.duration_extra_large
           when 'cat' then sc.duration_cat
           else (sc.species_pricing->v_pet_species->>'duration')::integer end
    into v_name, v_price, v_cur, v_dur, v_extra_dur, v_size_price, v_size_dur
  from public.service_catalog sc
  where sc.organization_id = gjp.organization_id and sc.id = p_service
    and sc.is_active = true and sc.deleted_at is null;
  if not found then
    raise exception 'service_not_active_or_not_in_org' using errcode = 'check_violation'; end if;

  if v_pet_species not in ('dog','cat') and v_size_price is null then
    raise exception 'species_price_not_configured' using errcode='22023'; end if;

  -- Size price wins only when the catalog actually defines one for this pet's
  -- size; a null size or a null column both fall back to base_price so every
  -- pre-existing service (no matrix configured) behaves exactly as before.
  if v_pet_size is not null and v_size_price is not null then
    v_final_price := v_size_price; v_source := 'size_matrix';
  else
    v_final_price := coalesce(v_price, 0); v_source := 'base';
  end if;

  -- Additional duration only ever ADDS time for units beyond the first, and
  -- defaults to 0, so a service that never configured it schedules exactly
  -- as it did before this migration regardless of quantity.
  v_final_dur := coalesce(v_size_dur, v_dur, 60) + coalesce(v_extra_dur, 0) * greatest(p_quantity - 1, 0);

  insert into public.grooming_job_pet_services
    (organization_id, grooming_job_pet_id, service_id, service_name_snapshot,
     unit_price_snapshot, currency, quantity, duration_minutes,
     pet_size_snapshot, price_source)
  values (gjp.organization_id, gjp.id, p_service, coalesce(v_name,'Service'),
          v_final_price, coalesce(v_cur,'USD'), p_quantity, v_final_dur,
          v_pet_size, v_source)
  returning id into v_id;
  perform app.assembly_audit(gjp.organization_id, gjp.grooming_job_id, 'grooming.line_added',
    jsonb_build_object('grooming_job_pet_service_id', v_id, 'service_id', p_service,
                       'quantity', p_quantity, 'unit_price_snapshot', v_final_price,
                       'duration_minutes', v_final_dur, 'pet_size', v_pet_size, 'price_source', v_source));
  return v_id;
end; $$;

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
       or not exists(select 1 from public.organization_pet_types t where t.organization_id=v_org and t.key=v_pet->>'species' and t.is_active)
       or (nullif(v_pet->>'size','') is not null and v_pet->>'size' not in ('extra_small','small','medium','large','extra_large')) then
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

-- Anonymous registration can see only the active pet-type labels belonging to
-- the valid single-use token's organization, never the organization catalog.
create function public.get_onboarding_pet_types(p_token text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_org uuid;
begin
  select l.organization_id into v_org from public.customer_onboarding_links l
    join public.organizations o on o.id=l.organization_id
    where l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex')
      and l.status='active' and l.expires_at>now() and o.status in ('trial','active') and o.deleted_at is null;
  if v_org is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('key',t.key,'label',t.label) order by t.label)
    from public.organization_pet_types t where t.organization_id=v_org and t.is_active),'[]'::jsonb);
end;
$$;
revoke all on function public.get_onboarding_pet_types(text) from public;
grant execute on function public.get_onboarding_pet_types(text) to anon,authenticated;

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
    if not exists(select 1 from public.organization_pet_types t where t.organization_id=v_org and t.key=v_pet->>'species' and t.is_active) then raise exception 'invalid_pet' using errcode='22023'; end if;
    v_client_pet_id:=left(coalesce(v_pet->>'clientId',''),80);
    insert into public.pets(organization_id,customer_id,name,species,breed,size,weight_kg,color,notes,status,metadata)
    values(v_org,v_customer,left(trim(v_pet->>'name'),80),v_pet->>'species',left(nullif(trim(v_pet->>'breed'),''),100),nullif(v_pet->>'size',''),nullif(v_pet->>'weightKg','')::numeric,left(nullif(trim(v_pet->>'color'),''),80),left(nullif(trim(v_pet->>'notes'),''),1000),'active',jsonb_build_object('created_from','self_onboarding','stated_age',coalesce(v_pet->>'age',''),'onboarding_submission_id',v_sub.id,'client_pet_id',v_client_pet_id)) returning id into v_pet_id;
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

create or replace function app.amend_customer_onboarding(
  p_submission uuid, p_payload jsonb, p_expected_updated_at timestamptz
) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_row public.customer_onboarding_submissions;
  v_pet jsonb;
  v_updated timestamptz;
begin
  if v_org is null or not app.has_permission('customer.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.customer_onboarding_submissions
    where organization_id = v_org and id = p_submission and status = 'submitted' for update;
  if not found then raise exception 'submission_not_found' using errcode = 'P0002'; end if;
  if v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'submission_changed' using errcode = '40001';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or length(trim(coalesce(p_payload->>'customerName',''))) not between 2 and 120
     or length(trim(coalesce(p_payload->>'phone',''))) not between 7 and 40
     or length(trim(coalesce(p_payload->>'addressLine',''))) not between 1 and 200
     or length(trim(coalesce(p_payload->>'province',''))) < 2
     or length(trim(coalesce(p_payload->>'kabupatenKota',''))) < 2
     or length(trim(coalesce(p_payload->>'kecamatan',''))) < 2
     or length(coalesce(p_payload->>'googleMapsUrl','')) > 1000
     or jsonb_typeof(p_payload->'pets') is distinct from 'array'
     or jsonb_array_length(p_payload->'pets') not between 1 and 5
     or length(p_payload::text) > 32768 then
    raise exception 'invalid_submission' using errcode = '22023';
  end if;
  for v_pet in select value from jsonb_array_elements(p_payload->'pets') loop
    if length(trim(coalesce(v_pet->>'name',''))) not between 1 and 80
       or not exists(select 1 from public.organization_pet_types t where t.organization_id=v_org and t.key=v_pet->>'species' and t.is_active)
       or nullif(v_pet->>'weightKg','') is null
       or (v_pet->>'weightKg') !~ '^\d{1,3}(\.\d{1,3})?$'
       or (v_pet->>'weightKg')::numeric <= 0 then
      raise exception 'invalid_pet' using errcode = '22023';
    end if;
  end loop;
  update public.customer_onboarding_submissions set payload = p_payload
    where organization_id = v_org and id = p_submission returning updated_at into v_updated;
  return v_updated;
end $$;

create or replace function app.submit_customer_onboarding(p_token text,p_payload jsonb)
returns uuid language plpgsql security definer set search_path=app,public,extensions as $$
declare v_link public.customer_onboarding_links; v_id uuid; v_pets jsonb;
begin
  select l.* into v_link from public.customer_onboarding_links l
    join public.organizations o on o.id=l.organization_id and o.status in ('trial','active') and o.deleted_at is null
    where l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update of l;
  if not found or v_link.status<>'active' then raise exception 'link_not_available' using errcode='P0002'; end if;
  if v_link.expires_at<=now() then raise exception 'link_expired' using errcode='22023'; end if;
  v_pets:=p_payload->'pets';
  if jsonb_typeof(p_payload)<>'object' or length(trim(coalesce(p_payload->>'customerName','')))<2 or length(trim(coalesce(p_payload->>'phone','')))<7
     or jsonb_typeof(v_pets)<>'array' or jsonb_array_length(v_pets)<1 or jsonb_array_length(v_pets)>5 then
    raise exception 'invalid_submission' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(v_pets) p where length(trim(coalesce(p->>'name','')))<1
    or not exists(select 1 from public.organization_pet_types t where t.organization_id=v_link.organization_id and t.key=p->>'species' and t.is_active)) then raise exception 'invalid_pet' using errcode='22023'; end if;
  insert into public.customer_onboarding_submissions(organization_id,link_id,payload) values(v_link.organization_id,v_link.id,p_payload) returning id into v_id;
  update public.customer_onboarding_links set status='submitted' where id=v_link.id;
  return v_id;
end $$;

commit;
