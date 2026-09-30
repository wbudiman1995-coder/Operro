-- Forward-only HomePaw starter bands. Existing prices and durations stay unchanged
-- until an owner opts into a template or edits an individual service.
begin;

alter table public.pets drop constraint chk_pets_size;
alter table public.pets add constraint chk_pets_size
  check (size is null or size in ('extra_small','small','medium','large','extra_large'));
alter table public.grooming_job_pet_services drop constraint chk_gjps_pet_size_snapshot;
alter table public.grooming_job_pet_services add constraint chk_gjps_pet_size_snapshot
  check (pet_size_snapshot is null or pet_size_snapshot in ('extra_small','small','medium','large','extra_large','cat'));

alter table public.service_catalog
  add column price_extra_small numeric(14,2),
  add column price_cat numeric(14,2),
  add column duration_extra_small integer,
  add column duration_small integer,
  add column duration_medium integer,
  add column duration_large integer,
  add column duration_extra_large integer,
  add column duration_cat integer;
alter table public.service_catalog
  add constraint chk_service_price_extra_small check (price_extra_small is null or price_extra_small >= 0),
  add constraint chk_service_price_cat check (price_cat is null or price_cat >= 0),
  add constraint chk_service_duration_bands check (
    (duration_extra_small is null or duration_extra_small >= 0) and
    (duration_small is null or duration_small >= 0) and
    (duration_medium is null or duration_medium >= 0) and
    (duration_large is null or duration_large >= 0) and
    (duration_extra_large is null or duration_extra_large >= 0) and
    (duration_cat is null or duration_cat >= 0)
  );

-- Weight is authoritative when present, so a stale client-supplied size cannot
-- underprice a dog. Dogs without a measured weight may still be sized manually.
create function app.tg_homepaw_pet_size_from_weight() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if new.species = 'cat' then
    new.size := null;
  elsif new.species = 'dog' and new.weight_kg is not null then
    new.size := case
      when new.weight_kg < 5 then 'extra_small'
      when new.weight_kg < 10 then 'small'
      when new.weight_kg < 15 then 'medium'
      when new.weight_kg <= 25 then 'large'
      else 'extra_large' end;
  end if;
  return new;
end $$;
create trigger trg_homepaw_pet_size_from_weight before insert or update of species,weight_kg,size on public.pets
for each row execute function app.tg_homepaw_pet_size_from_weight();

-- The following CREATE OR REPLACE definitions preserve signatures, grants,
-- tenant guards, and audit behavior from the earlier migrations.

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
  elsif v_pet_species = 'dog' and v_pet_weight is not null then
    v_pet_size := case when v_pet_weight < 5 then 'extra_small'
      when v_pet_weight < 10 then 'small' when v_pet_weight < 15 then 'medium'
      when v_pet_weight <= 25 then 'large' else 'extra_large' end;
  end if;

  select sc.name, sc.base_price, sc.currency, sc.duration_minutes, sc.additional_duration_minutes,
         case v_pet_size
           when 'extra_small' then sc.price_extra_small
           when 'small' then sc.price_small
           when 'medium' then sc.price_medium
           when 'large' then sc.price_large
           when 'extra_large' then sc.price_extra_large
           when 'cat' then sc.price_cat
           else null end,
         case v_pet_size
           when 'extra_small' then sc.duration_extra_small
           when 'small' then sc.duration_small
           when 'medium' then sc.duration_medium
           when 'large' then sc.duration_large
           when 'extra_large' then sc.duration_extra_large
           when 'cat' then sc.duration_cat
           else null end
    into v_name, v_price, v_cur, v_dur, v_extra_dur, v_size_price, v_size_dur
  from public.service_catalog sc
  where sc.organization_id = gjp.organization_id and sc.id = p_service
    and sc.is_active = true and sc.deleted_at is null;
  if not found then
    raise exception 'service_not_active_or_not_in_org' using errcode = 'check_violation'; end if;

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

commit;
