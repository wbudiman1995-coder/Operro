-- Dynamic tenant-owned size bands, Bundle 3: booking/package/customer adapters.
-- Client callers never supply an organization, pricing key, price, label, or
-- layout version. Every value is derived from the authenticated active tenant
-- and the existing authoritative app.resolve_service_line/pet_pricing_key path.
begin;

create function app.resolve_pet_pricing_keys(p_pet_ids uuid[])
returns table (pet_id uuid, pricing_key text, size_label text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  v_org := app.fn_active_organization();
  if v_org is null or not (app.is_operro_owner() or app.has_membership()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query
    select p.id,
           k.pricing_key,
           case
             when k.pricing_key is null then null
             when p.species in ('dog','cat') then b.label
             else t.label
           end
    from public.pets p
    cross join lateral (select app.pet_pricing_key(v_org, p.species, p.weight_kg, p.size) as pricing_key) k
    left join public.organization_size_bands b
      on b.organization_id = v_org and b.band_key = k.pricing_key
    left join public.organization_pet_types t
      on t.organization_id = v_org and t.key = k.pricing_key
    where p.organization_id = v_org
      and p.deleted_at is null
      and p.id = any(coalesce(p_pet_ids, array[]::uuid[]));
end $$;

create function app.preview_booking_resolution(p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_item jsonb; v_pet public.pets; v_res record; v_result jsonb := '[]'::jsonb;
        v_pet_id uuid; v_service_id uuid; v_quantity integer;
begin
  v_org := app.fn_active_organization();
  if v_org is null or (not app.is_operro_owner() and (
       not app.has_membership() or not app.has_module('scheduling')
       or not (app.has_permission('booking.create') or app.has_permission('booking.update')))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid_booking_resolution_items' using errcode = '22023';
  end if;

  -- Serialize the complete preview against a layout edit. assembly_add_line
  -- takes the same lock again when snapshots are written.
  perform app.size_layout_lock(v_org);
  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_pet_id := (v_item->>'pet_id')::uuid;
      v_service_id := (v_item->>'service_id')::uuid;
      v_quantity := coalesce((v_item->>'quantity')::integer, 1);
    exception when others then
      raise exception 'invalid_booking_resolution_items' using errcode = '22023';
    end;
    if v_quantity < 1 then raise exception 'quantity_must_be_positive' using errcode = '23514'; end if;
    select * into v_pet from public.pets p
      where p.organization_id = v_org and p.id = v_pet_id and p.deleted_at is null;
    if not found then raise exception 'pet_not_found' using errcode = 'P0002'; end if;
    select * into v_res from app.resolve_service_line(
      v_org, v_service_id, v_pet.species, v_pet.weight_kg, v_pet.size, v_quantity);
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'pet_id', v_pet_id, 'service_id', v_service_id, 'quantity', v_quantity,
      'pricing_key', v_res.pricing_key, 'size_label', v_res.size_label,
      'unit_price', v_res.unit_price, 'duration_minutes', v_res.duration,
      'price_source', v_res.price_source, 'layout_version', v_res.layout_version,
      'service_name', v_res.service_name, 'currency', v_res.currency));
  end loop;
  return v_result;
end $$;

-- The renewal preview must use the same server-side size rule as the write
-- trigger. The entitlement fingerprint and write behavior remain unchanged.
create or replace function app.preview_package_renewal(p_customer_package uuid)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid; cp public.customer_packages; pkg public.packages; pet public.pets;
  v_interval interval; v_new_expiry timestamptz; v_reserved_count integer; v_unreserved_excess integer;
  v_pet_incompatible boolean; v_service_incompatible boolean; v_size_incompatible boolean := false;
begin
  v_org := app.fn_active_organization();
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.read');
  select * into pkg from public.packages where organization_id = v_org and id = cp.package_id;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  select count(*) into v_reserved_count from public.package_reservations
   where organization_id = v_org and customer_package_id = cp.id and status = 'reserved';
  v_pet_incompatible := cp.status <> 'canceled' and pkg.per_pet and cp.pet_id is null;
  v_service_incompatible := cp.status <> 'canceled' and cp.service_id is not null and pkg.service_id is not null and cp.service_id <> pkg.service_id;
  if cp.status <> 'canceled' and pkg.size_band is not null and cp.pet_id is not null then
    select * into pet from public.pets p where p.organization_id = v_org and p.id = cp.pet_id and p.deleted_at is null;
    v_size_incompatible := not found or app.pet_pricing_key(v_org, pet.species, pet.weight_kg, pet.size) is distinct from pkg.size_band;
  end if;
  v_interval := case pkg.recurrence_interval when 'week' then interval '7 days' when 'month' then interval '1 month'
    when 'year' then interval '1 year' else (coalesce(pkg.validity_days, 30) || ' days')::interval end;
  v_new_expiry := greatest(now(), coalesce(cp.expires_at, now())) + v_interval;
  v_unreserved_excess := case when pkg.rollover_policy = 'none' then greatest(0, cp.sessions_remaining - v_reserved_count) else 0 end;
  return jsonb_build_object(
    'customer_package_id', cp.id, 'package_id', pkg.id, 'package_name', pkg.name,
    'price', pkg.price, 'currency', pkg.currency, 'sessions_to_add', pkg.total_sessions,
    'rollover_policy', pkg.rollover_policy, 'recurrence_interval', pkg.recurrence_interval,
    'pet_id', cp.pet_id, 'service_id', cp.service_id,
    'current_available', greatest(0, cp.sessions_remaining - v_reserved_count),
    'sessions_discarded_if_renewed', v_unreserved_excess,
    'resulting_available', greatest(0, cp.sessions_remaining - v_reserved_count) - v_unreserved_excess + pkg.total_sessions,
    'current_expires_at', cp.expires_at, 'resulting_expires_at', v_new_expiry,
    'catalog_active', pkg.is_active, 'membership_status', cp.status,
    'pet_scope_incompatible', v_pet_incompatible, 'service_scope_incompatible', v_service_incompatible,
    'size_incompatible', v_size_incompatible,
    'incompatible', v_pet_incompatible or v_service_incompatible or v_size_incompatible,
    'blocking_reason', case when cp.status = 'canceled' then 'package_canceled_cannot_renew'
      when not pkg.is_active then 'package_catalog_inactive'
      when v_size_incompatible then 'package_size_mismatch_on_renewal'
      when v_pet_incompatible or v_service_incompatible then 'catalog_terms_changed_incompatible_with_existing_entitlement'
      else null end,
    'terms_fingerprint', app.fn_renewal_terms_fingerprint(pkg, cp, v_reserved_count), 'generated_at', now());
end $$;

revoke all on function app.resolve_pet_pricing_keys(uuid[]), app.preview_booking_resolution(jsonb) from public, anon, authenticated;
grant execute on function app.resolve_pet_pricing_keys(uuid[]), app.preview_booking_resolution(jsonb) to authenticated;
revoke all on function app.preview_package_renewal(uuid) from public, anon, authenticated;
grant execute on function app.preview_package_renewal(uuid) to authenticated;

commit;
