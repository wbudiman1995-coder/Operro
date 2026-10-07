\set ON_ERROR_STOP on
-- Bundle 3 adapter behavior. Run after size_band_management_smoke.sql so the
-- established SB-05 dynamic/legacy fixtures are available.

create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('5e000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;

-- The owner fixture needs the capabilities used by the two read RPCs.
insert into public.role_permissions(organization_id,role_id,permission_id)
select v.org,v.role,p.id from (values (pg_temp.u(11),pg_temp.u(41)),(pg_temp.u(10),pg_temp.u(42))) v(org,role)
cross join public.permissions p where p.key in ('booking.create','booking.update','membership.read') on conflict do nothing;

-- W40 is authoritative extra_large after the management smoke's rollback.
insert into public.packages(id,organization_id,name,service_id,total_sessions,price,currency,validity_days,
  recurrence_interval,per_pet,size_band,is_active)
values(pg_temp.u(180),pg_temp.u(11),'Adapter XL',pg_temp.u(70),2,500000,'IDR',30,'month',true,'extra_large',true);
insert into public.customer_packages(id,organization_id,customer_id,package_id,service_id,pet_id,sessions_remaining,status)
values(pg_temp.u(181),pg_temp.u(11),pg_temp.u(60),pg_temp.u(180),pg_temp.u(70),pg_temp.u(95),2,'active');

begin;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(11))::text,true);
do $$
declare v_keys record; v_preview jsonb; v_renew jsonb;
begin
  select count(*) n, min(pricing_key) key, min(size_label) label into v_keys
  from app.resolve_pet_pricing_keys(array[pg_temp.u(95),pg_temp.u(80)]);
  if v_keys.n <> 1 or v_keys.key <> 'extra_large' or v_keys.label <> 'XL' then
    raise exception 'FAIL tenant-scoped pet resolution: %', row_to_json(v_keys); end if;

  v_preview := app.preview_booking_resolution(jsonb_build_array(jsonb_build_object(
    'pet_id',pg_temp.u(95),'service_id',pg_temp.u(70),'quantity',1)));
  if jsonb_array_length(v_preview) <> 1
     or v_preview->0->>'pricing_key' <> 'extra_large'
     or (v_preview->0->>'unit_price')::numeric <> 300000
     or (v_preview->0->>'duration_minutes')::integer <> 120
     or v_preview->0->>'size_label' <> 'XL'
     or (v_preview->0->>'layout_version')::integer <> (select layout_version from public.organization_size_band_settings where organization_id=pg_temp.u(11)) then
    raise exception 'FAIL authoritative booking preview: %',v_preview; end if;

  v_renew := app.preview_package_renewal(pg_temp.u(181));
  if (v_renew->>'size_incompatible')::boolean or (v_renew->>'incompatible')::boolean then
    raise exception 'FAIL matching renewal preview: %',v_renew; end if;
  raise notice 'PASS Bundle 3 server-derived pet key/label, booking price/duration/layout, tenant filtering, and matching renewal preview';
end $$;
commit;

-- Weight changes affect the live renewal gate but never the sold entitlement snapshots.
select set_config('request.jwt.claims','{}',false);
update public.pets set weight_kg=12 where id=pg_temp.u(95) and organization_id=pg_temp.u(11);
begin;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(11))::text,true);
do $$ declare v jsonb; begin
  v := app.preview_package_renewal(pg_temp.u(181));
  if not (v->>'size_incompatible')::boolean or not (v->>'incompatible')::boolean
     or v->>'blocking_reason' <> 'package_size_mismatch_on_renewal' then
    raise exception 'FAIL renewal mismatch preview: %',v; end if;
  if (select size_band_snapshot||':'||size_label_snapshot from public.customer_packages where id=pg_temp.u(181)) <> 'extra_large:XL' then
    raise exception 'FAIL sold package snapshot changed after pet reband'; end if;
  raise notice 'PASS exact renewal mismatch is server-resolved while sold key/label snapshots remain immutable';
end $$;
commit;

-- Platform owners use the same selected-tenant adapters without requiring a
-- tenant membership row, matching the existing workspace access contract.
begin;
select set_config('request.jwt.claims',jsonb_build_object(
  'sub',(select id from public.users where lower(email)='wbudiman1995@gmail.com'),
  'role','authenticated','active_org_id',pg_temp.u(11),
  'app_metadata',jsonb_build_object('is_platform_admin',true))::text,true);
set local role authenticated;
do $$ declare v_preview jsonb; begin
  if (select count(*) from app.resolve_pet_pricing_keys(array[pg_temp.u(95)])) <> 1 then
    raise exception 'FAIL platform pet adapter access'; end if;
  v_preview := app.preview_booking_resolution(jsonb_build_array(jsonb_build_object(
    'pet_id',pg_temp.u(95),'service_id',pg_temp.u(70),'quantity',1)));
  if jsonb_array_length(v_preview) <> 1 then
    raise exception 'FAIL platform booking adapter access: %',v_preview; end if;
  raise notice 'PASS platform owner adapter access follows the selected tenant';
end $$;
rollback;

-- ACL/RLS contract: authenticated only; no arbitrary organization argument;
-- another tenant receives no row for the known foreign pet id.
do $$
begin
  if has_function_privilege('anon','app.resolve_pet_pricing_keys(uuid[])','execute')
     or has_function_privilege('anon','app.preview_booking_resolution(jsonb)','execute')
     or has_function_privilege('public','app.resolve_pet_pricing_keys(uuid[])','execute')
     or has_function_privilege('public','app.preview_booking_resolution(jsonb)','execute') then
    raise exception 'FAIL adapter RPC exposed to anon/public'; end if;
end $$;
begin;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(32),'role','authenticated','active_org_id',pg_temp.u(10))::text,true);
do $$ begin
  if exists(select 1 from app.resolve_pet_pricing_keys(array[pg_temp.u(95)])) then
    raise exception 'FAIL cross-tenant pet key leaked'; end if;
  begin
    perform app.preview_booking_resolution(jsonb_build_array(jsonb_build_object('pet_id',pg_temp.u(95),'service_id',pg_temp.u(70))));
    raise exception 'ACCEPTED';
  exception when others then
    if sqlerrm='ACCEPTED' or sqlerrm not like 'pet_not_found%' then raise exception 'FAIL cross-tenant booking preview: % %',sqlstate,sqlerrm; end if;
  end;
  raise notice 'PASS Bundle 3 RPC ACL and cross-tenant isolation';
end $$;
rollback;
