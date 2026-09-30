-- Owner-editable dog weight cutoffs. All price/package/booking decisions use
-- the same authoritative organization boundary function.
begin;

create table public.organization_dog_size_boundaries (
  organization_id uuid primary key references public.organizations(id),
  xs_lt_kg numeric(6,2) not null,
  s_lt_kg numeric(6,2) not null,
  m_lt_kg numeric(6,2) not null,
  l_lte_kg numeric(6,2) not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint chk_dog_size_boundaries_order check (xs_lt_kg > 0 and xs_lt_kg < s_lt_kg and s_lt_kg < m_lt_kg and m_lt_kg < l_lte_kg and l_lte_kg <= 999)
);
alter table public.organization_dog_size_boundaries enable row level security;
grant select on public.organization_dog_size_boundaries to authenticated;
create policy organization_dog_size_boundaries_read on public.organization_dog_size_boundaries
  for select to authenticated using (app.is_operro_owner() or (organization_id=app.fn_active_organization() and app.has_membership()));

create function app.dog_size_for_weight(p_org uuid,p_weight numeric) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_xs numeric := 5; v_s numeric := 10; v_m numeric := 15; v_l numeric := 25;
begin
  if p_weight is null or p_weight<=0 then return null; end if;
  select xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg into v_xs,v_s,v_m,v_l
    from public.organization_dog_size_boundaries where organization_id=p_org;
  if not found then v_xs:=5; v_s:=10; v_m:=15; v_l:=25; end if;
  return case when p_weight<v_xs then 'extra_small' when p_weight<v_s then 'small'
    when p_weight<v_m then 'medium' when p_weight<=v_l then 'large' else 'extra_large' end;
end;
$$;
revoke all on function app.dog_size_for_weight(uuid,numeric) from public;

create or replace function app.tg_homepaw_pet_size_from_weight() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if new.species='cat' then new.size:=null;
  elsif new.species='dog' and new.weight_kg is not null then
    new.size:=app.dog_size_for_weight(new.organization_id,new.weight_kg);
  end if;
  return new;
end $$;

create function app.set_dog_size_boundaries(p_org uuid,p_xs numeric,p_s numeric,p_m numeric,p_l numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_xs is null or p_s is null or p_m is null or p_l is null
    or not (p_xs>0 and p_xs<p_s and p_s<p_m and p_m<p_l and p_l<=999)
  then raise exception 'invalid_boundaries' using errcode='22023'; end if;
  perform 1 from public.organizations where id=p_org and status in ('trial','active') for update;
  if not found then raise exception 'organization_unavailable' using errcode='22023'; end if;
  -- A sold active size-specific package must never silently become unusable.
  if exists (
    select 1 from public.customer_packages cp
    join public.packages pkg on pkg.id=cp.package_id and pkg.organization_id=cp.organization_id
    join public.pets pet on pet.id=cp.pet_id and pet.organization_id=cp.organization_id
    where cp.organization_id=p_org and cp.status='active' and cp.deleted_at is null
      and pkg.size_band is not null and pet.species='dog' and pet.weight_kg is not null
      and pkg.size_band is distinct from case
        when pet.weight_kg<p_xs then 'extra_small' when pet.weight_kg<p_s then 'small'
        when pet.weight_kg<p_m then 'medium' when pet.weight_kg<=p_l then 'large' else 'extra_large' end
  ) then raise exception 'active_package_size_would_change' using errcode='23514'; end if;
  insert into public.organization_dog_size_boundaries(organization_id,xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg,updated_at,updated_by)
  values(p_org,p_xs,p_s,p_m,p_l,now(),auth.uid())
  on conflict (organization_id) do update set xs_lt_kg=excluded.xs_lt_kg,s_lt_kg=excluded.s_lt_kg,
    m_lt_kg=excluded.m_lt_kg,l_lte_kg=excluded.l_lte_kg,updated_at=excluded.updated_at,updated_by=excluded.updated_by;
  -- Trigger recomputes authoritative size for every measured dog; historical
  -- invoice/job snapshots remain unchanged.
  update public.pets set weight_kg=weight_kg
    where organization_id=p_org and species='dog' and weight_kg is not null and deleted_at is null;
end;
$$;
revoke all on function app.set_dog_size_boundaries(uuid,numeric,numeric,numeric,numeric) from public;
grant execute on function app.set_dog_size_boundaries(uuid,numeric,numeric,numeric,numeric) to authenticated;

-- The booking assembly and package guards below are forward replacements of
-- their latest definitions, changing only the weight-to-band decision.

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

create or replace function app.tg_homepaw_package_pet_band() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_band text; v_species text; v_size text; v_weight numeric; v_per_pet boolean; v_pkg_band text;
begin
  select size_band, per_pet into v_pkg_band, v_per_pet from public.packages
  where id=new.package_id and organization_id=new.organization_id for share;
  if v_pkg_band is null then return new; end if;
  if not v_per_pet or new.pet_id is null then
    raise exception 'pet_required_for_size_package' using errcode='22023';
  end if;
  select species,size,weight_kg into v_species,v_size,v_weight from public.pets
  where id=new.pet_id and organization_id=new.organization_id and customer_id=new.customer_id and deleted_at is null for share;
  if not found then raise exception 'pet_not_found_for_customer' using errcode='P0002'; end if;
  v_band := case when v_species='cat' then 'cat'
    when v_species='dog' then coalesce(app.dog_size_for_weight(new.organization_id,v_weight),v_size)
    else null end;
  if v_band is distinct from v_pkg_band then
    raise exception 'package_size_mismatch' using errcode='22023';
  end if;
  return new;
end $$;

create or replace function app.tg_homepaw_renewal_pet_band() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_band text; v_pkg_band text; v_species text; v_size text; v_weight numeric;
begin
  if new.reason <> 'renewal' then return new; end if;
  select pkg.size_band, pet.species, pet.size, pet.weight_kg
    into v_pkg_band, v_species, v_size, v_weight
  from public.customer_packages cp
  join public.packages pkg on pkg.id=cp.package_id and pkg.organization_id=cp.organization_id
  left join public.pets pet on pet.id=cp.pet_id and pet.organization_id=cp.organization_id
  where cp.id=new.customer_package_id and cp.organization_id=new.organization_id;
  if v_pkg_band is null then return new; end if;
  v_band := case when v_species='cat' then 'cat'
    when v_species='dog' then coalesce(app.dog_size_for_weight(new.organization_id,v_weight),v_size)
    else null end;
  if v_band is distinct from v_pkg_band then
    raise exception 'package_size_mismatch_on_renewal' using errcode='22023';
  end if;
  return new;
end $$;

commit;
