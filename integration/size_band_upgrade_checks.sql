\set ON_ERROR_STOP on
-- Post-upgrade assertions for the populated rehearsal (after SB-01..SB-04).
\ir size_band_oracle.sql

do $$
declare v_orgs integer; v_bad text;
begin
  select count(*) into v_orgs from public.organizations;
  if (select count(*) from public.organization_size_band_settings) <> v_orgs
     or (select count(*) from public.organization_size_bands) <> v_orgs * 6
     or exists (select 1 from public.organizations o where
          (select count(*) from public.organization_size_bands b where b.organization_id=o.id and b.band_kind='dog_weight' and b.status='active') <> 5
          or not exists (select 1 from public.organization_size_bands b where b.organization_id=o.id and b.band_key='cat' and b.band_kind='cat')
          or not exists (select 1 from public.organization_size_band_settings s where s.organization_id=o.id and s.mode='legacy' and s.layout_version=1)) then
    raise exception 'FAIL U-04 backfill did not cover every organization (incl. soft-deleted)'; end if;
  if not exists (select 1 from public.organizations where deleted_at is not null) then raise exception 'FAIL fixture has no soft-deleted organization'; end if;
  -- U-03: bands equal the old boundaries (custom row) or the 5/10/15/25 defaults (no row), large inclusive
  select string_agg(o.id::text, ',') into v_bad from public.organizations o
  left join public.organization_dog_size_boundaries b on b.organization_id=o.id
  where (select string_agg(coalesce(trim_scale(upper_kg)::text,'open')||case when upper_inclusive then 'i' else '' end,',' order by sort_order)
         from public.organization_size_bands x where x.organization_id=o.id and x.band_kind='dog_weight' and x.status='active')
        is distinct from coalesce(trim_scale(b.xs_lt_kg)||','||trim_scale(b.s_lt_kg)||','||trim_scale(b.m_lt_kg)||','||trim_scale(b.l_lte_kg)||'i,open','5,10,15,25i,open');
  if v_bad is not null then raise exception 'FAIL U-03 backfilled bands differ from the previous boundaries for orgs %', v_bad; end if;
  if (select count(*) from public.organization_dog_size_boundaries) <> 2 then raise exception 'FAIL fixture boundary rows changed'; end if;
  raise notice 'PASS U-03/U-04 % organizations (incl. soft-deleted, custom-boundary and no-row) backfilled with five legacy bands + cat, legacy mode, boundaries copied verbatim', v_orgs;
end $$;

do $$
declare r record; v_n integer := 0; v_new text; v_old text;
begin
  -- FK/CHECK replacement actually happened and every existing row validated
  if exists (select 1 from pg_constraint where conname in ('chk_pets_size','chk_packages_size_band'))
     or exists (select 1 from pg_constraint where conname in ('fk_pets_size_band','fk_packages_size_band') and not convalidated)
     or (select count(*) from pg_constraint where conname in ('fk_pets_size_band','fk_packages_size_band')) <> 2 then
    raise exception 'FAIL SB-04 constraint swap'; end if;
  -- resolver equals the oracle for every real pet x service in the populated data (legacy mode)
  for r in select p.organization_id org, p.species, p.weight_kg w, p.size, s.id svc from public.pets p
           join public.service_catalog s on s.organization_id=p.organization_id and s.is_active and s.deleted_at is null loop
    v_n := v_n + 1;
    v_new := pg_temp.new_line(r.org,r.svc,r.species,r.w,r.size,2);
    v_old := pg_temp.old_line(r.org,r.svc,r.species,r.w,r.size,2);
    if v_new is distinct from v_old then raise exception 'FAIL resolver differs from the pre-migration rules: [%] vs [%]', v_new, v_old; end if;
  end loop;
  if v_n < 15 then raise exception 'FAIL too few populated pet x service combinations (%)', v_n; end if;
  -- weight -> band for every measured dog, plus the 25.00 / 25.01 edge, equals the old function
  for r in select organization_id org, weight_kg w from public.pets where species='dog' and weight_kg is not null loop
    if app.dog_size_for_weight(r.org,r.w) is distinct from pg_temp.old_dog_size(r.org,r.w) then raise exception 'FAIL band differs for % %', r.org, r.w; end if;
  end loop;
  if app.dog_size_for_weight('5c000000-0000-4000-8000-000000000002',25.00) <> 'large'
     or app.dog_size_for_weight('5c000000-0000-4000-8000-000000000002',25.01) <> 'extra_large' then raise exception 'FAIL 25.00/25.01 edge'; end if;
  if app.dog_size_for_weight('5c000000-0000-4000-8000-000000000001',26.00) <> 'large'
     or app.dog_size_for_weight('5c000000-0000-4000-8000-000000000001',26.01) <> 'extra_large' then raise exception 'FAIL custom-boundary edge'; end if;
  raise notice 'PASS U-01/U-03 resolver parity on populated data: % pet x service combinations; every measured dog equals the old function', v_n;
end $$;

do $$
begin
  -- service_band_prices mirrors the legacy columns of every service incl. the soft-deleted one
  if exists (select 1 from (
       select organization_id,id,k,p,d from public.service_catalog sc cross join lateral (values
         ('extra_small',sc.price_extra_small,sc.duration_extra_small),('small',sc.price_small,sc.duration_small),('medium',sc.price_medium,sc.duration_medium),
         ('large',sc.price_large,sc.duration_large),('extra_large',sc.price_extra_large,sc.duration_extra_large),('cat',sc.price_cat,sc.duration_cat)) v(k,p,d)
       where p is not null or d is not null
       except select organization_id,service_id,pricing_key,price,duration_minutes from public.service_band_prices) x)
     or exists (select 1 from (select organization_id,service_id,pricing_key,price,duration_minutes from public.service_band_prices
       except select organization_id,id,k,p,d from public.service_catalog sc cross join lateral (values
         ('extra_small',sc.price_extra_small,sc.duration_extra_small),('small',sc.price_small,sc.duration_small),('medium',sc.price_medium,sc.duration_medium),
         ('large',sc.price_large,sc.duration_large),('extra_large',sc.price_extra_large,sc.duration_extra_large),('cat',sc.price_cat,sc.duration_cat)) v(k,p,d)
       where p is not null or d is not null) y) then
    raise exception 'FAIL service_band_prices backfill differs from the legacy columns'; end if;
  if not exists (select 1 from public.service_band_prices where service_id='5c000000-0000-4000-8000-000000000304') then
    raise exception 'FAIL soft-deleted service was not backfilled'; end if;
  if exists (select 1 from public.service_band_prices where service_id='5c000000-0000-4000-8000-000000000303') then
    raise exception 'FAIL base-only service must have no band rows'; end if;
  raise notice 'PASS U-03 service_band_prices backfill equals the legacy price/duration columns (NULL stays no row)';
end $$;

-- the migrated data still behaves: sized packages keep guarding sale/renewal,
-- existing entitlements are untouched, new snapshot columns are null for history
do $$
begin
  if exists (select 1 from public.grooming_job_pet_services where pet_size_label_snapshot is not null or pet_weight_kg_snapshot is not null or size_layout_version_snapshot is not null)
     or exists (select 1 from public.customer_packages where size_band_snapshot is not null or size_label_snapshot is not null) then
    raise exception 'FAIL historical rows must keep NULL new snapshot columns'; end if;
  begin
    insert into public.customer_packages(organization_id,customer_id,package_id,pet_id)
    values ('5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000c1','5c000000-0000-4000-8000-000000000701','5c000000-0000-4000-8000-000000000101');
    raise exception 'FAIL XS dog bought the large-band package';
  exception when sqlstate '22023' then
    if sqlerrm <> 'package_size_mismatch' then raise; end if;
  end;
  insert into public.customer_packages(id,organization_id,customer_id,package_id,pet_id,sessions_remaining)
  values ('5c000000-0000-4000-8000-0000000008f1','5c000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-0000000000c1','5c000000-0000-4000-8000-000000000701','5c000000-0000-4000-8000-000000000112',1);
  if (select size_band_snapshot||'/'||size_label_snapshot from public.customer_packages where id='5c000000-0000-4000-8000-0000000008f1') <> 'large/L' then
    raise exception 'FAIL new entitlement snapshot'; end if;
  raise notice 'PASS U-01 migrated packages still enforce the size band on sale; history snapshots stay NULL';
end $$;
