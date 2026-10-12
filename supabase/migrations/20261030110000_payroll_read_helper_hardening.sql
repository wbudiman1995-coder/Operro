-- Harden the remaining payroll read helpers left over from the S32/S33 engine.
-- Browser-callable helpers now verify the active organization and payroll.read;
-- calculation-only helpers are no longer executable by browser roles. Every
-- helper uses an empty search_path while retaining its existing result contract.
begin;

alter function app.org_timezone(uuid) set search_path = '';
alter function app.org_today(uuid) set search_path = '';
alter function app.payroll_working_day_stats(uuid, uuid, date, date) set search_path = '';
alter function app.payroll_eligible_pets(uuid, date, date) set search_path = '';
alter function app.payroll_transport_shares(uuid, date, date) set search_path = '';

create or replace function app.payroll_cycle_bounds(p_org uuid, p_anchor date default null)
returns table(period_start date, period_end date)
security definer set search_path = ''
language plpgsql stable as $$
declare
  v_day integer;
  v_anchor date := coalesce(p_anchor, app.org_today(p_org));
  v_start date;
begin
  perform app.assert_tenant_authorized(p_org, 'payroll', 'payroll.read', null);
  if v_anchor < date '2000-01-01' or v_anchor > date '2100-12-31' then
    raise exception 'invalid_payroll_anchor' using errcode = '22023';
  end if;

  select coalesce(s.cycle_start_day, 26) into v_day
    from public.payroll_cycle_settings s
   where s.organization_id = p_org;
  v_day := coalesce(v_day, 26);

  v_start := (date_trunc('month', v_anchor) + make_interval(days => v_day - 1))::date;
  if v_anchor < v_start then
    v_start := (date_trunc('month', v_anchor - interval '1 month') + make_interval(days => v_day - 1))::date;
  end if;
  period_start := v_start;
  period_end := (v_start + interval '1 month')::date;
  return next;
end $$;

create or replace function app.payroll_missing_invoice_pets(p_org uuid, p_period_start date, p_period_end date)
returns table(grooming_job_pet_id uuid, booking_id uuid, membership_id uuid, pet_id uuid, starts_at timestamptz)
security definer set search_path = ''
language plpgsql stable as $$
begin
  perform app.assert_tenant_authorized(p_org, 'payroll', 'payroll.read', null);
  if p_period_start is null or p_period_end is null or p_period_start >= p_period_end
     or p_period_end - p_period_start > 366
     or p_period_start < date '2000-01-01' or p_period_end > date '2101-01-01' then
    raise exception 'invalid_payroll_period' using errcode = '22023';
  end if;

  return query
  select gjp.id, gjp.grooming_job_id, r.membership_id, gjp.pet_id, b.starts_at
    from public.grooming_job_pets gjp
    join public.bookings b
      on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    join public.resources r
      on r.organization_id = gjp.organization_id and r.id = gjp.assigned_resource_id
     and r.membership_id is not null
   where gjp.organization_id = p_org and gjp.deleted_at is null and gjp.status = 'complete'
     and (b.starts_at at time zone app.org_timezone(p_org))::date >= p_period_start
     and (b.starts_at at time zone app.org_timezone(p_org))::date < p_period_end
     and not exists (
       select 1
         from public.orders ord
         join public.invoices inv
           on inv.organization_id = ord.organization_id and inv.order_id = ord.id
        where ord.organization_id = b.organization_id and ord.booking_id = b.id
          and ord.deleted_at is null and inv.status <> 'void'
     );
end $$;

-- Only the two guarded entry points are callable from PostgREST. The other
-- helpers remain available to owner-defined payroll functions.
revoke all on function app.org_timezone(uuid), app.org_today(uuid),
  app.payroll_working_day_stats(uuid, uuid, date, date),
  app.payroll_eligible_pets(uuid, date, date),
  app.payroll_transport_shares(uuid, date, date) from public, anon, authenticated;
revoke all on function app.payroll_cycle_bounds(uuid, date),
  app.payroll_missing_invoice_pets(uuid, date, date) from public, anon, authenticated;
grant execute on function app.payroll_cycle_bounds(uuid, date),
  app.payroll_missing_invoice_pets(uuid, date, date) to authenticated;

create or replace function app.schema_version() returns text
language sql immutable set search_path = '' as $$
  select '20261030110000'::text;
$$;

notify pgrst, 'reload schema';
commit;
