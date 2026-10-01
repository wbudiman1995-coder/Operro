-- Tenant-defined dog weight bands. Stable keys keep historical invoices and
-- payroll snapshots readable; owners may edit labels/cutoffs or remove unused
-- bands. Prices and durations for new bands live in service_catalog JSONB.
begin;

create table public.organization_dog_size_bands (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  label text not null,
  sort_order integer not null,
  upper_kg numeric(6,2),
  primary key (organization_id,key),
  unique (organization_id,sort_order),
  constraint chk_dog_band_key check (key ~ '^[a-z][a-z0-9_]{1,29}$'),
  constraint chk_dog_band_label check (length(trim(label)) between 1 and 24),
  constraint chk_dog_band_upper check (upper_kg is null or upper_kg > 0)
);
alter table public.organization_dog_size_bands enable row level security;
grant select on public.organization_dog_size_bands to authenticated;
create policy organization_dog_size_bands_read on public.organization_dog_size_bands
  for select to authenticated using
    (app.is_operro_owner() or (organization_id=app.fn_active_organization() and app.has_membership()));

insert into public.organization_dog_size_bands (organization_id,key,label,sort_order,upper_kg)
select o.id, b.key, b.label, b.ord, b.upper_kg
from public.organizations o
left join public.organization_dog_size_boundaries d on d.organization_id=o.id
cross join lateral (values
  ('extra_small','XS',1,coalesce(d.xs_lt_kg,5)),
  ('small','S',2,coalesce(d.s_lt_kg,10)),
  ('medium','M',3,coalesce(d.m_lt_kg,15)),
  ('large','L',4,coalesce(d.l_lte_kg,25)+0.01),
  ('extra_large','XL',5,null::numeric)
) b(key,label,ord,upper_kg);

create function app.seed_dog_size_bands() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.organization_dog_size_bands(organization_id,key,label,sort_order,upper_kg)
  values (new.id,'extra_small','XS',1,5),(new.id,'small','S',2,10),
    (new.id,'medium','M',3,15),(new.id,'large','L',4,25.01),
    (new.id,'extra_large','XL',5,null);
  return new;
end $$;
create trigger trg_seed_dog_size_bands after insert on public.organizations
  for each row execute function app.seed_dog_size_bands();

alter table public.pets drop constraint chk_pets_size;
alter table public.pets add constraint chk_pets_size
  check (size is null or size ~ '^[a-z][a-z0-9_]{1,29}$');
alter table public.packages drop constraint chk_packages_size_band;
alter table public.packages add constraint chk_packages_size_band
  check (size_band is null or size_band = 'cat' or size_band ~ '^[a-z][a-z0-9_]{1,29}$');

alter table public.service_catalog add column dog_size_pricing jsonb not null default '{}'::jsonb;
alter table public.service_catalog add constraint chk_service_dog_size_pricing
  check (jsonb_typeof(dog_size_pricing)='object');
update public.service_catalog sc set dog_size_pricing =
  jsonb_strip_nulls(jsonb_build_object(
    'extra_small',jsonb_strip_nulls(jsonb_build_object('price',sc.price_extra_small,'duration',sc.duration_extra_small)),
    'small',jsonb_strip_nulls(jsonb_build_object('price',sc.price_small,'duration',sc.duration_small)),
    'medium',jsonb_strip_nulls(jsonb_build_object('price',sc.price_medium,'duration',sc.duration_medium)),
    'large',jsonb_strip_nulls(jsonb_build_object('price',sc.price_large,'duration',sc.duration_large)),
    'extra_large',jsonb_strip_nulls(jsonb_build_object('price',sc.price_extra_large,'duration',sc.duration_extra_large))));

create or replace function app.dog_size_for_weight(p_org uuid,p_weight numeric) returns text
language sql stable security definer set search_path='' as $$
  select b.key from public.organization_dog_size_bands b
  where b.organization_id=p_org and p_weight>0 and (b.upper_kg is null or p_weight<b.upper_kg)
  order by b.sort_order limit 1;
$$;

-- Validate proposed bands without touching the current mapping. Used while
-- checking sold package eligibility before a replacement is allowed.
create function app.dog_size_from_band_payload(p_bands jsonb,p_weight numeric) returns text
language sql immutable set search_path='' as $$
  select row.value->>'key' from jsonb_array_elements(p_bands) with ordinality row(value,ord)
  where p_weight>0 and (row.value->>'upperKg' is null or p_weight < (row.value->>'upperKg')::numeric)
  order by row.ord limit 1;
$$;

create function app.replace_dog_size_bands(p_org uuid,p_bands jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare
  v_row jsonb;
  v_count integer;
  v_index integer:=0;
  v_upper numeric;
  v_previous numeric:=0;
  v_key text;
  v_label text;
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  if jsonb_typeof(p_bands) is distinct from 'array' then raise exception 'invalid_bands' using errcode='22023'; end if;
  v_count:=jsonb_array_length(p_bands);
  if v_count not between 1 and 20 then raise exception 'invalid_bands' using errcode='22023'; end if;
  perform 1 from public.organizations where id=p_org and status in ('trial','active') for update;
  if not found then raise exception 'organization_unavailable' using errcode='22023'; end if;
  for v_row in select value from jsonb_array_elements(p_bands) loop
    v_index:=v_index+1;
    if jsonb_typeof(v_row) <> 'object' then raise exception 'invalid_bands' using errcode='22023'; end if;
    v_key:=v_row->>'key'; v_label:=trim(v_row->>'label');
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{1,29}$'
       or v_label is null or length(v_label) not between 1 and 24
       or exists (select 1 from jsonb_array_elements(p_bands) with ordinality r(value,ord)
                  where r.value->>'key'=v_key and r.ord<v_index)
    then raise exception 'invalid_bands' using errcode='22023'; end if;
    if v_index=v_count then
      if v_row->>'upperKg' is not null then raise exception 'last_band_must_be_open' using errcode='22023'; end if;
    else
      if (v_row->>'upperKg') !~ '^[0-9]+(\.[0-9]{1,2})?$' then raise exception 'invalid_band_limit' using errcode='22023'; end if;
      v_upper:=(v_row->>'upperKg')::numeric;
      if v_upper<=v_previous or v_upper>999 then raise exception 'invalid_band_order' using errcode='22023'; end if;
      v_previous:=v_upper;
    end if;
  end loop;

  -- A catalog package or active entitlement may still reference a key that is
  -- being removed. Archive/change the catalog and finish entitlements first.
  if exists (select 1 from public.packages pkg where pkg.organization_id=p_org
    and pkg.size_band is not null and pkg.size_band<>'cat'
    and (pkg.deleted_at is null and pkg.is_active or exists (
      select 1 from public.customer_packages cp where cp.package_id=pkg.id
        and cp.organization_id=p_org and cp.status='active' and cp.deleted_at is null))
    and not exists (select 1 from jsonb_array_elements(p_bands) r where r->>'key'=pkg.size_band))
  then raise exception 'band_has_package' using errcode='23514'; end if;
  if exists (select 1 from public.pets pet where pet.organization_id=p_org
    and pet.species='dog' and pet.weight_kg is null and pet.size is not null
    and pet.deleted_at is null
    and not exists (select 1 from jsonb_array_elements(p_bands) r where r->>'key'=pet.size))
  then raise exception 'band_has_unmeasured_pet' using errcode='23514'; end if;
  if exists (
    select 1 from public.customer_packages cp
    join public.packages pkg on pkg.id=cp.package_id and pkg.organization_id=cp.organization_id
    join public.pets pet on pet.id=cp.pet_id and pet.organization_id=cp.organization_id
    where cp.organization_id=p_org and cp.status='active' and cp.deleted_at is null
      and pkg.size_band is not null and pet.species='dog' and pet.weight_kg is not null
      and pkg.size_band is distinct from app.dog_size_from_band_payload(p_bands,pet.weight_kg)
  ) then raise exception 'active_package_size_would_change' using errcode='23514'; end if;

  -- Remove/reinsert as a single transaction; existing financial snapshots keep
  -- their stable key. The organization row lock serializes owner edits.
  delete from public.organization_dog_size_bands where organization_id=p_org;
  insert into public.organization_dog_size_bands(organization_id,key,label,sort_order,upper_kg)
  select p_org,value->>'key',trim(value->>'label'),ord::integer,(value->>'upperKg')::numeric
  from jsonb_array_elements(p_bands) with ordinality row(value,ord);
  update public.pets set weight_kg=weight_kg where organization_id=p_org
    and species='dog' and weight_kg is not null and deleted_at is null;
end $$;
revoke all on function app.replace_dog_size_bands(uuid,jsonb) from public;
grant execute on function app.replace_dog_size_bands(uuid,jsonb) to authenticated;
-- Avoid the legacy fixed-cutoff API silently changing an obsolete table.
revoke execute on function app.set_dog_size_boundaries(uuid,numeric,numeric,numeric,numeric) from authenticated;

create function app.validate_package_size_band() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.size_band is not null and new.size_band<>'cat' and not exists (
    select 1 from public.organization_dog_size_bands b
    where b.organization_id=new.organization_id and b.key=new.size_band
  ) then raise exception 'unknown_size_band' using errcode='23514'; end if;
  return new;
end $$;
create trigger trg_validate_package_size_band before insert or update of size_band,organization_id on public.packages
  for each row execute function app.validate_package_size_band();

-- The latest assembly function (20261020120000) still reads five fixed price
-- columns. Prefer the tenant-defined matrix, retaining those columns as a
-- fallback for older catalog rows and Cat.
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
  if v_pet_species = 'cat' then v_pet_size := 'cat';
  elsif v_pet_species = 'dog' then
    v_pet_size := coalesce(app.dog_size_for_weight(gjp.organization_id, v_pet_weight), v_pet_size);
  else v_pet_size := v_pet_species;
  end if;
  select sc.name, sc.base_price, sc.currency, sc.duration_minutes, sc.additional_duration_minutes,
         coalesce((sc.dog_size_pricing->v_pet_size->>'price')::numeric,
           case v_pet_size
             when 'extra_small' then sc.price_extra_small when 'small' then sc.price_small
             when 'medium' then sc.price_medium when 'large' then sc.price_large
             when 'extra_large' then sc.price_extra_large when 'cat' then sc.price_cat
             else (sc.species_pricing->v_pet_species->>'price')::numeric end),
         coalesce((sc.dog_size_pricing->v_pet_size->>'duration')::integer,
           case v_pet_size
             when 'extra_small' then sc.duration_extra_small when 'small' then sc.duration_small
             when 'medium' then sc.duration_medium when 'large' then sc.duration_large
             when 'extra_large' then sc.duration_extra_large when 'cat' then sc.duration_cat
             else (sc.species_pricing->v_pet_species->>'duration')::integer end)
    into v_name, v_price, v_cur, v_dur, v_extra_dur, v_size_price, v_size_dur
  from public.service_catalog sc
  where sc.organization_id = gjp.organization_id and sc.id = p_service
    and sc.is_active = true and sc.deleted_at is null;
  if not found then raise exception 'service_not_active_or_not_in_org' using errcode = 'check_violation'; end if;
  if v_pet_species not in ('dog','cat') and v_size_price is null then
    raise exception 'species_price_not_configured' using errcode='22023'; end if;
  if v_pet_size is not null and v_size_price is not null then
    v_final_price := v_size_price; v_source := 'size_matrix';
  else v_final_price := coalesce(v_price, 0); v_source := 'base'; end if;
  v_final_dur := coalesce(v_size_dur, v_dur, 60) + coalesce(v_extra_dur, 0) * greatest(p_quantity - 1, 0);
  insert into public.grooming_job_pet_services
    (organization_id, grooming_job_pet_id, service_id, service_name_snapshot,
     unit_price_snapshot, currency, quantity, duration_minutes,pet_size_snapshot,price_source)
  values (gjp.organization_id, gjp.id, p_service, coalesce(v_name,'Service'),
          v_final_price, coalesce(v_cur,'USD'), p_quantity, v_final_dur,v_pet_size,v_source)
  returning id into v_id;
  perform app.assembly_audit(gjp.organization_id, gjp.grooming_job_id, 'grooming.line_added',
    jsonb_build_object('grooming_job_pet_service_id', v_id, 'service_id', p_service,
                       'quantity', p_quantity, 'unit_price_snapshot', v_final_price,
                       'duration_minutes', v_final_dur, 'pet_size', v_pet_size, 'price_source', v_source));
  return v_id;
end; $$;

-- Household creation accepts any active dog band when weight is unknown.
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
       or (nullif(v_pet->>'size','') is not null and not exists(select 1 from public.organization_dog_size_bands b where b.organization_id=v_org and b.key=v_pet->>'size')) then
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


commit;
