-- Reject missing observed revisions without changing authorized repair retries.
-- Forward-only: preserve historical migrations and existing function grants.
begin;

create or replace function app.update_customer_package_terms(
  p_customer_package uuid, p_revision integer, p_reason text,
  p_expires_at timestamptz, p_pet uuid, p_service uuid)
returns public.customer_packages
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid; cp public.customer_packages; v_has_reservations boolean;
  v_pet_changed boolean; v_service_changed boolean;
begin
  v_org := app.fn_active_organization();
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.manage');

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'correction_reason_required' using errcode = 'check_violation';
  end if;
  if cp.revision is distinct from p_revision then raise exception 'stale_correction_request' using errcode = '40001'; end if;
  if cp.status = 'canceled' then raise exception 'package_canceled_cannot_edit' using errcode = 'check_violation'; end if;

  v_pet_changed := p_pet is distinct from cp.pet_id;
  v_service_changed := p_service is distinct from cp.service_id;

  if v_pet_changed or v_service_changed then
    if cp.renewal_count > 0 then
      raise exception 'entitlement_scope_locked_after_renewal' using errcode = 'check_violation';
    end if;
    select exists(
      select 1 from public.package_reservations
       where organization_id = v_org and customer_package_id = cp.id
    ) into v_has_reservations;
    if v_has_reservations then
      raise exception 'entitlement_scope_locked_after_first_reservation' using errcode = 'check_violation';
    end if;
  end if;

  if v_pet_changed and p_pet is not null
     and not exists(select 1 from public.pets where organization_id = v_org and id = p_pet and customer_id = cp.customer_id and deleted_at is null) then
    raise exception 'pet_not_found_for_customer' using errcode = 'P0002';
  end if;
  if v_service_changed and p_service is not null
     and not exists(select 1 from public.service_catalog where organization_id = v_org and id = p_service and deleted_at is null) then
    raise exception 'service_not_found' using errcode = 'P0002';
  end if;

  update public.customer_packages
     set expires_at = p_expires_at, pet_id = p_pet, service_id = p_service, revision = revision + 1
   where id = cp.id;

  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'package', cp.id, app.fn_current_user_id(), 'membership.terms_corrected', 'membership.terms_corrected',
          jsonb_build_object(
            'reason', p_reason,
            'before', jsonb_build_object('expires_at', cp.expires_at, 'pet_id', cp.pet_id, 'service_id', cp.service_id),
            'after', jsonb_build_object('expires_at', p_expires_at, 'pet_id', p_pet, 'service_id', p_service)));

  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  return cp;
end; $$;

create or replace function app.repair_customer_package_balance(p_customer_package uuid, p_revision integer, p_request_key uuid)
returns public.customer_packages
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid; cp public.customer_packages; v_ledger_balance numeric;
begin
  v_org := app.fn_active_organization();
  if p_request_key is null then raise exception 'request_key_required' using errcode = 'check_violation'; end if;
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  -- Distinct, explicit authorization for the WRITE path (reconcile_customer_package
  -- only requires membership.read; repairing requires membership.manage).
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.manage');
  if exists (select 1 from public.timeline_events where organization_id = v_org and subject_type = 'package'
             and subject_id = p_customer_package and event_type = 'membership.balance_repaired' and data->>'request_key' = p_request_key::text) then
    return cp;
  end if;
  if exists (select 1 from public.timeline_events where organization_id = v_org and subject_type = 'package'
             and event_type = 'membership.balance_repaired' and data->>'request_key' = p_request_key::text) then
    raise exception 'request_key_reused_for_different_package' using errcode = '22023';
  end if;
  if cp.revision is distinct from p_revision then
    raise exception 'stale_repair_request' using errcode = '40001';
  end if;
  select coalesce(sum(delta), 0) into v_ledger_balance
    from public.customer_package_ledger where organization_id = v_org and customer_package_id = p_customer_package;
  if v_ledger_balance <> cp.sessions_remaining then
    update public.customer_packages set sessions_remaining = v_ledger_balance, revision = revision + 1 where id = cp.id;
  end if;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'package', p_customer_package, app.fn_current_user_id(), 'membership.balance_repaired', 'membership.balance_repaired',
          jsonb_build_object('request_key', p_request_key, 'cached_before', cp.sessions_remaining, 'ledger_balance', v_ledger_balance));
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  return cp;
end; $$;

notify pgrst, 'reload schema';
commit;
