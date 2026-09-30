-- Optional, owner-editable HomePaw membership tiers. Existing packages and
-- sold entitlements are untouched. Size is enforced at purchase time.
begin;

alter table public.packages
  add column size_band text,
  add column discount_percent numeric(5,2),
  add column visit_interval_days integer;
alter table public.packages
  add constraint chk_packages_size_band check (size_band is null or size_band in ('extra_small','small','medium','large','extra_large','cat')),
  add constraint chk_packages_discount_percent check (discount_percent is null or discount_percent between 0 and 100),
  add constraint chk_packages_visit_interval check (visit_interval_days is null or visit_interval_days between 1 and 365),
  add constraint chk_packages_size_requires_pet check (size_band is null or (per_pet and service_id is not null));

-- Existing sold terms keep their purchased size. A catalog edit cannot silently
-- turn those entitlements into another band or erase the size restriction.
create function app.tg_homepaw_lock_sold_package_size() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if old.size_band is distinct from new.size_band and exists (
    select 1 from public.customer_packages cp
    where cp.organization_id=old.organization_id and cp.package_id=old.id
  ) then raise exception 'sold_package_size_locked' using errcode='23514'; end if;
  return new;
end $$;
create trigger trg_homepaw_lock_sold_package_size before update of size_band on public.packages
for each row execute function app.tg_homepaw_lock_sold_package_size();

create function app.tg_homepaw_package_pet_band() returns trigger
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
  v_band := case
    when v_species='cat' then 'cat'
    when v_species<>'dog' then null
    when v_weight is null then v_size
    when v_weight<5 then 'extra_small'
    when v_weight<10 then 'small'
    when v_weight<15 then 'medium'
    when v_weight<=25 then 'large'
    else 'extra_large' end;
  if v_band is distinct from v_pkg_band then
    raise exception 'package_size_mismatch' using errcode='22023';
  end if;
  return new;
end $$;
create trigger trg_homepaw_package_pet_band before insert on public.customer_packages
for each row execute function app.tg_homepaw_package_pet_band();

-- A purchased term is honored for its original pet even if its weight changes.
-- Renewing at the old, cheaper size is refused; sell the correctly sized tier
-- for the next term instead. This runs within the invoice/ledger transaction,
-- so a refused renewal cannot leave behind a charge without sessions.
create function app.tg_homepaw_renewal_pet_band() returns trigger
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
  v_band := case
    when v_species='cat' then 'cat'
    when v_species<>'dog' then null
    when v_weight is null then v_size
    when v_weight<5 then 'extra_small'
    when v_weight<10 then 'small'
    when v_weight<15 then 'medium'
    when v_weight<=25 then 'large'
    else 'extra_large' end;
  if v_band is distinct from v_pkg_band then
    raise exception 'package_size_mismatch_on_renewal' using errcode='22023';
  end if;
  return new;
end $$;
create trigger trg_homepaw_renewal_pet_band before insert on public.customer_package_ledger
for each row execute function app.tg_homepaw_renewal_pet_band();

commit;
