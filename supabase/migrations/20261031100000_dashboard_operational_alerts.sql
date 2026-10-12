-- P1: bounded operational alerts for the dashboard (read-only).
--
-- Adds ONE read function, app.dashboard_operational_alerts(p_keys), and one optional dashboard card key,
-- "operational_alerts" (organization-owned visibility, same settings object as the other dashboard cards).
-- Every alert is a count over an existing authoritative record with a fixed, documented threshold; none is a
-- score, forecast or ROI. Nothing is written and no customer identity, contact data, note or file reference is returned.
--
--   overdue_invoices     invoices.status = 'issued', due_at < now(), and the total exceeds the succeeded payments on it
--                        (same "remaining" rule as the dashboard outstanding snapshot). Per currency: count, remaining
--                        amount, oldest due date. Needs finance.read + finance module; branch-limited like invoices RLS.
--   expiring_packages    customer_packages.status = 'active', not deleted, sessions_remaining > 0, expires_at within the
--                        next 7 days. (HomePaw: "membership expiring dalam 7 hari".) Needs membership.read + module
--                        membership. The packages table itself is not branch-scoped, so neither is this count.
--   stale_open_bookings  bookings still requested / confirmed / in_progress although they started more than 24 hours ago
--                        (looking back 90 days): a visit nobody closed out. Needs booking.read + scheduling, not a
--                        Groomer-role member; branch-limited.
--   maintenance_problems organization exports failed in 30 days or running for over 2 hours, and storage-cleanup apply
--                        runs failed / partial / abandoned in 30 days or running past their lease (same predicates as
--                        app.health_summary). Business owner only.
-- Not an alert, on purpose: double-booked resources (booking_resources has an EXCLUDE constraint, so they cannot exist),
-- and "unbilled completed visits", which already has an authoritative, paged invoker RPC (app.reconcile_unbilled_visits)
-- that the application calls directly.
--
-- Why SECURITY DEFINER: same reason as 20261030100000 (the branch RLS helper costs ~0.84 ms per row; the branch set is
-- resolved once here instead). The organization comes only from the session; every table read states
-- organization_id = v_org and the branch filter; a requested key the caller may not read raises 42501 (never a zero).
begin;

-- ---------------------------------------------------------------------------------------------------------------
-- Card visibility: the four legacy keys stay mandatory, the three performance keys stay all-or-none, and the new
-- optional operational_alerts key is independent. Any optional key a payload omits keeps its stored value.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.update_dashboard_card_settings(p_cards jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_key text;
  v_legacy constant text[] := array['booking_today','revenue_today','active_customers','open_tasks'];
  v_group constant text[] := array['performance_operations','performance_finance','performance_sources'];
  v_alerts constant text := 'operational_alerts';
  v_settings jsonb;
  v_dashboard jsonb;
  v_current jsonb;
  v_cards jsonb;
  v_supplied integer := 0;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_cards is null or jsonb_typeof(p_cards) <> 'object' then
    raise exception 'invalid_dashboard_cards' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_cards) loop
    if v_key <> all(v_legacy || v_group || v_alerts) then
      raise exception 'invalid_dashboard_card_key' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array v_legacy loop
    if jsonb_typeof(p_cards -> v_key) is distinct from 'boolean' then
      raise exception 'invalid_dashboard_card_value' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array v_group loop
    if p_cards ? v_key then
      v_supplied := v_supplied + 1;
      if jsonb_typeof(p_cards -> v_key) is distinct from 'boolean' then
        raise exception 'invalid_dashboard_card_value' using errcode = '22023';
      end if;
    end if;
  end loop;
  if v_supplied not in (0, cardinality(v_group)) then
    raise exception 'invalid_dashboard_card_key' using errcode = '22023';
  end if;
  if p_cards ? v_alerts and jsonb_typeof(p_cards -> v_alerts) is distinct from 'boolean' then
    raise exception 'invalid_dashboard_card_value' using errcode = '22023';
  end if;

  select settings into v_settings from public.organizations where id = v_org for update;
  if not found then raise exception 'not_authorized' using errcode = '42501'; end if;
  if jsonb_typeof(v_settings) is distinct from 'object' then v_settings := '{}'::jsonb; end if;
  v_dashboard := case when jsonb_typeof(v_settings -> 'dashboard') = 'object' then v_settings -> 'dashboard' else '{}'::jsonb end;
  v_current := case when jsonb_typeof(v_dashboard -> 'cards') = 'object' then v_dashboard -> 'cards' else '{}'::jsonb end;

  v_cards := p_cards;
  -- Omitted optional keys keep whatever boolean is stored; an absent key stays absent (= visible in the application).
  if v_supplied = 0 then
    foreach v_key in array v_group loop
      if jsonb_typeof(v_current -> v_key) = 'boolean' then v_cards := v_cards || jsonb_build_object(v_key, v_current -> v_key); end if;
    end loop;
  end if;
  if not p_cards ? v_alerts and jsonb_typeof(v_current -> v_alerts) = 'boolean' then
    v_cards := v_cards || jsonb_build_object(v_alerts, v_current -> v_alerts);
  end if;

  update public.organizations
     set settings = v_settings || jsonb_build_object('dashboard', v_dashboard || jsonb_build_object('cards', v_cards))
   where id = v_org;
end $$;

revoke all on function app.update_dashboard_card_settings(jsonb) from public, anon, authenticated;
grant execute on function app.update_dashboard_card_settings(jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Supporting index: open bookings that may be stale (partial, tiny).
-- ---------------------------------------------------------------------------------------------------------------
create index if not exists idx_bookings_org_open_starts_at on public.bookings (organization_id, starts_at)
  where deleted_at is null and status in ('requested','confirmed','in_progress');
create index if not exists idx_customer_packages_org_active_expiry on public.customer_packages (organization_id, expires_at)
  where deleted_at is null and status = 'active';

-- ---------------------------------------------------------------------------------------------------------------
-- The alert reader.
-- ---------------------------------------------------------------------------------------------------------------
create function app.dashboard_operational_alerts(p_keys text[])
returns table (alert_key text, currency text, item_count integer, amount numeric, oldest_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_allowed constant text[] := array['overdue_invoices','expiring_packages','stale_open_bookings','maintenance_problems'];
  v_key text;
  v_all boolean;
  v_branches uuid[] := '{}';
begin
  if v_org is null or not app.has_membership() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_keys is null or cardinality(p_keys) not between 1 and 4 then
    raise exception 'invalid_alert_keys' using errcode = '22023';
  end if;
  foreach v_key in array p_keys loop
    if v_key is null or v_key <> all(v_allowed) then raise exception 'invalid_alert_keys' using errcode = '22023'; end if;
  end loop;
  if (select count(distinct k) from unnest(p_keys) k) <> cardinality(p_keys) then
    raise exception 'invalid_alert_keys' using errcode = '22023';
  end if;

  -- Authorize every requested key before reading anything.
  if 'overdue_invoices' = any(p_keys)
     and not (app.has_permission('finance.read') and app.has_module('finance')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if 'expiring_packages' = any(p_keys)
     and not (app.has_permission('membership.read') and app.has_module('membership')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if 'stale_open_bookings' = any(p_keys)
     and (not app.has_permission('booking.read') or not app.has_module('scheduling') or app.is_groomer_member()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if 'maintenance_problems' = any(p_keys) and not app.is_business_owner_member(v_org) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_all := app.has_permission('branches.all');
  if not v_all then
    select coalesce(array_agg(mba.branch_id), '{}') into v_branches
      from public.memberships m
      join public.membership_branch_access mba on mba.organization_id = m.organization_id and mba.membership_id = m.id
     where m.user_id = app.fn_current_user_id() and m.organization_id = v_org and m.status = 'active' and m.deleted_at is null;
  end if;

  if 'overdue_invoices' = any(p_keys) then
    return query
    with due as (
      select i.currency as cur, i.due_at,
             i.total - coalesce((select sum(p.amount) from public.payments p
                                  where p.organization_id = v_org and p.invoice_id = i.id and p.status = 'succeeded'), 0) as remaining
        from public.invoices i
       where i.organization_id = v_org and i.status = 'issued' and i.due_at < now()
         and (v_all or i.branch_id = any(v_branches))
    ), agg as (
      select d.cur, count(*)::integer as n, sum(d.remaining) as amt, min(d.due_at) as oldest
        from due d where d.remaining > 0 group by d.cur
    )
    select 'overdue_invoices'::text, a.cur, a.n, a.amt, a.oldest from agg a
    union all
    select 'overdue_invoices'::text, null::text, 0, null::numeric, null::timestamptz where not exists (select 1 from agg)
    order by 2 nulls last;
  end if;

  if 'expiring_packages' = any(p_keys) then
    return query
    select 'expiring_packages'::text, null::text, count(*)::integer, null::numeric, min(cp.expires_at)
      from public.customer_packages cp
     where cp.organization_id = v_org and cp.deleted_at is null and cp.status = 'active' and cp.sessions_remaining > 0
       and cp.expires_at >= now() and cp.expires_at < now() + interval '7 days';
  end if;

  if 'stale_open_bookings' = any(p_keys) then
    return query
    select 'stale_open_bookings'::text, null::text, count(*)::integer, null::numeric, min(b.starts_at)
      from public.bookings b
     where b.organization_id = v_org and b.deleted_at is null and b.status in ('requested','confirmed','in_progress')
       and b.starts_at < now() - interval '24 hours' and b.starts_at >= now() - interval '90 days'
       and (v_all or b.branch_id = any(v_branches));
  end if;

  if 'maintenance_problems' = any(p_keys) then
    return query
    select 'maintenance_problems'::text, null::text,
           ((select count(*) from public.organization_export_jobs j
              where j.organization_id = v_org
                and ((j.status = 'failed' and j.created_at > now() - interval '30 days')
                  or (j.status = 'running' and j.created_at < now() - interval '2 hours')))
          + (select count(*) from public.storage_cleanup_runs r
              where r.organization_id = v_org and r.mode = 'apply'
                and ((r.status in ('failed','partial','abandoned') and r.started_at > now() - interval '30 days')
                  or (r.status = 'running' and r.lease_expires_at < now()))))::integer,
           null::numeric,
           (select min(t) from (
              select j.created_at as t from public.organization_export_jobs j
               where j.organization_id = v_org
                 and ((j.status = 'failed' and j.created_at > now() - interval '30 days')
                   or (j.status = 'running' and j.created_at < now() - interval '2 hours'))
              union all
              select r.started_at from public.storage_cleanup_runs r
               where r.organization_id = v_org and r.mode = 'apply'
                 and ((r.status in ('failed','partial','abandoned') and r.started_at > now() - interval '30 days')
                   or (r.status = 'running' and r.lease_expires_at < now()))) x);
  end if;
end $$;

revoke all on function app.dashboard_operational_alerts(text[]) from public, anon, authenticated;
grant execute on function app.dashboard_operational_alerts(text[]) to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261031100000'::text;
$$;

notify pgrst, 'reload schema';
commit;
