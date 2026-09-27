-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20261001110000_payroll_engine_s32_rpcs
-- Purpose          The actual payroll calculation + lifecycle RPCs
--                  implementing docs/handoffs/ENGINE-3-S32-S33-HANDOFF.md
--                  Section 5, on top of 20261001100000's schema.
-- Objects Created  app.org_today, app.payroll_cycle_bounds,
--                  app.payroll_working_day_stats, app.payroll_eligible_pets,
--                  app.payroll_transport_shares, app.compute_payroll_item,
--                  app.recompute_payroll_run, app.approve_payroll_run,
--                  app.pay_payroll_run, app.undo_payroll_payment,
--                  app.set_payroll_item_override, app.clear_payroll_item_override,
--                  app.upsert_payroll_custom_row, app.delete_payroll_custom_row,
--                  app.pay_retention_deposit, app.publish_payroll_snapshot,
--                  app.unpublish_payroll_snapshot, app.get_my_payroll_snapshot.
--                  Restrictive RLS capability policies for every table added
--                  in 20261001100000 (module 'payroll').
-- Concurrency      Every mutating RPC locks payroll_runs (`for update`) FIRST,
--                  then re-checks state -- this serializes recompute vs
--                  approve vs pay vs undo on the SAME run, and idempotency is
--                  "check natural state, no-op if already done" (see the note
--                  at the end of 20261001100000), not a request-id ledger.
-- =====================================================================

begin;

-- =====================================================================
-- SECTION 1 — Business-timezone "today" and cycle bounds.
--
-- organizations has no timezone column -- only branches does. Resolves to
-- the org's default branch's timezone (falling back to its oldest branch,
-- then UTC), since payroll_cycle_settings/payroll_runs are org-wide by
-- default (calculation contract 5.1) and a single-location business like
-- HomePaw has exactly one real timezone regardless of branch count.
-- =====================================================================
create or replace function app.org_timezone(p_org uuid)
returns text
security definer set search_path = app, public
language sql stable as $$
  select coalesce(
    (select b.timezone from public.branches b where b.organization_id = p_org and b.is_default = true and b.deleted_at is null limit 1),
    (select b.timezone from public.branches b where b.organization_id = p_org and b.deleted_at is null order by b.created_at limit 1),
    'UTC');
$$;

create or replace function app.org_today(p_org uuid)
returns date
security definer set search_path = app, public
language sql stable as $$
  select (now() at time zone app.org_timezone(p_org))::date;
$$;

-- Returns the [start,end) cycle containing p_anchor (defaults to org_today).
-- Pure date arithmetic in the ORG's business timezone -- never the app
-- server's or the browser's local clock (the bug both payroll/page.tsx's
-- currentMonthBounds and attendance/page.tsx's resolveCycle currently have).
create or replace function app.payroll_cycle_bounds(p_org uuid, p_anchor date default null)
returns table(period_start date, period_end date)
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_day int;
  v_anchor date := coalesce(p_anchor, app.org_today(p_org));
  v_start date;
begin
  select coalesce(cycle_start_day, 26) into v_day
  from public.payroll_cycle_settings where organization_id = p_org;
  v_day := coalesce(v_day, 26);

  v_start := (date_trunc('month', v_anchor) + make_interval(days => v_day - 1))::date;
  if v_anchor < v_start then
    v_start := (date_trunc('month', v_anchor - interval '1 month') + make_interval(days => v_day - 1))::date;
  end if;
  period_start := v_start;
  period_end := (v_start + interval '1 month')::date;
  return next;
end; $$;

revoke all on function app.org_timezone(uuid), app.org_today(uuid), app.payroll_cycle_bounds(uuid, date) from public;
grant execute on function app.org_timezone(uuid), app.org_today(uuid), app.payroll_cycle_bounds(uuid, date) to authenticated;

-- =====================================================================
-- SECTION 2 — Working-day / blocked-day stats for one membership+period.
-- Day-by-day loop (cycles are ~1 month, ~31 iterations) mirrors HomePaw's
-- own day-by-day JS loops exactly, which keeps this auditable against the
-- calculation contract instead of being a clever set-based rewrite that's
-- hard to verify.
-- =====================================================================
create or replace function app.payroll_working_day_stats(
  p_org uuid, p_membership uuid, p_period_start date, p_period_end date)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_resource uuid; v_hired_at date; v_today date;
  d date; v_dow int;
  v_scheduled boolean; v_blocked_any boolean; v_blocked_sick boolean;
  v_scheduled_count int := 0; v_worked_count int := 0; v_sick_count int := 0;
  v_week_key text; v_week_worked jsonb := '{}'::jsonb; v_cur int; v_weekly_paid_days int := 0;
begin
  select r.id, r.hired_at into v_resource, v_hired_at
  from public.resources r
  where r.organization_id = p_org and r.membership_id = p_membership and r.kind = 'staff' and r.deleted_at is null
  order by r.created_at limit 1;

  if v_resource is null then
    return jsonb_build_object('scheduled', 0, 'worked', 0, 'sick_days', 0, 'weekly_paid_days', 0);
  end if;

  v_today := app.org_today(p_org);
  d := p_period_start;
  while d < p_period_end loop
    if d <= v_today then
      v_dow := extract(dow from d)::int;
      select exists(
        select 1 from public.resource_availability ra
        where ra.organization_id = p_org and ra.resource_id = v_resource and ra.kind = 'available'
          and ra.day_of_week = v_dow and ra.deleted_at is null
          and (ra.effective_from is null or ra.effective_from <= d)
          and (ra.effective_to is null or ra.effective_to >= d)
      ) into v_scheduled;

      if v_scheduled then
        v_scheduled_count := v_scheduled_count + 1;

        select exists(
          select 1 from public.resource_availability ra
          where ra.organization_id = p_org and ra.resource_id = v_resource and ra.kind = 'blackout' and ra.deleted_at is null
            and d >= coalesce(ra.starts_at::date, ra.effective_from, d)
            and d <= coalesce(ra.ends_at::date, ra.effective_to, d)
        ) into v_blocked_any;

        select exists(
          select 1 from public.resource_availability ra
          where ra.organization_id = p_org and ra.resource_id = v_resource and ra.kind = 'blackout'
            and ra.reason = 'sick' and ra.deleted_at is null
            and d >= coalesce(ra.starts_at::date, ra.effective_from, d)
            and d <= coalesce(ra.ends_at::date, ra.effective_to, d)
        ) into v_blocked_sick;

        if not v_blocked_any then
          -- Branch-wide closure counts as a (non-sick) blocked day for payroll,
          -- but never against a groomer hired after that closure was recorded
          -- (join-date guard -- HomePaw's own 2026-09-26 fix, ported here).
          select exists(
            select 1 from public.branch_availability_blocks bab
            join public.resources r2 on r2.organization_id = bab.organization_id and r2.branch_id = bab.branch_id
            where bab.organization_id = p_org and r2.id = v_resource and bab.deleted_at is null
              and d >= bab.starts_at::date and d <= bab.ends_at::date
              and (v_hired_at is null or bab.starts_at::date >= v_hired_at)
          ) into v_blocked_any;
        end if;

        if v_blocked_sick then v_sick_count := v_sick_count + 1; end if;

        if not v_blocked_any then
          v_worked_count := v_worked_count + 1;
          v_week_key := (d - (extract(dow from d)::int))::text;
          v_cur := coalesce((v_week_worked ->> v_week_key)::int, 0) + 1;
          v_week_worked := jsonb_set(v_week_worked, array[v_week_key], to_jsonb(v_cur));
        end if;
      end if;
    end if;
    d := d + 1;
  end loop;

  select coalesce(sum(least(6, value::int)), 0) into v_weekly_paid_days from jsonb_each_text(v_week_worked);

  return jsonb_build_object('scheduled', v_scheduled_count, 'worked', v_worked_count,
    'sick_days', v_sick_count, 'weekly_paid_days', v_weekly_paid_days);
end; $$;

revoke all on function app.payroll_working_day_stats(uuid, uuid, date, date) from public;
grant execute on function app.payroll_working_day_stats(uuid, uuid, date, date) to authenticated;

-- =====================================================================
-- SECTION 3 — Eligible pets for a cycle: the single authoritative
-- eligibility+role join (5.4 of the calculation contract), reused by the
-- calculator, the missing-invoice queue, and (later) the exports so there
-- is never a second, independently-drifting definition of "counts".
-- =====================================================================
create or replace function app.payroll_eligible_pets(p_org uuid, p_period_start date, p_period_end date)
returns table(
  grooming_job_pet_id uuid, booking_id uuid, membership_id uuid, branch_id uuid, pet_id uuid,
  has_basic boolean, has_styling boolean, has_botak boolean, styling_revenue numeric
)
security definer set search_path = app, public
language sql stable as $$
  select gjp.id, gjp.grooming_job_id, r.membership_id, b.branch_id, gjp.pet_id,
    bool_or(sc.payroll_role = 'basic_grooming'),
    bool_or(sc.payroll_role = 'styling'),
    bool_or(sc.payroll_role = 'botak'),
    coalesce(sum(gjps.unit_price_snapshot * gjps.quantity) filter (where sc.payroll_role = 'styling'), 0)
  from public.grooming_job_pets gjp
  join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
  join public.resources r on r.organization_id = gjp.organization_id and r.id = gjp.assigned_resource_id and r.membership_id is not null
  join public.grooming_job_pet_services gjps on gjps.organization_id = gjp.organization_id
    and gjps.grooming_job_pet_id = gjp.id and gjps.deleted_at is null
  join public.service_catalog sc on sc.organization_id = gjps.organization_id and sc.id = gjps.service_id
  where gjp.organization_id = p_org and gjp.deleted_at is null and gjp.status = 'complete'
    and (b.starts_at at time zone app.org_timezone(p_org))::date >= p_period_start
    and (b.starts_at at time zone app.org_timezone(p_org))::date < p_period_end
    and exists (
      select 1 from public.orders ord
      join public.invoices inv on inv.organization_id = ord.organization_id and inv.order_id = ord.id
      where ord.organization_id = b.organization_id and ord.booking_id = b.id and ord.deleted_at is null
        and inv.status <> 'void'
    )
  group by gjp.id, gjp.grooming_job_id, r.membership_id, b.branch_id, gjp.pet_id;
$$;

revoke all on function app.payroll_eligible_pets(uuid, date, date) from public;
grant execute on function app.payroll_eligible_pets(uuid, date, date) to authenticated;

-- Completed pets whose booking has NO invoice at all -- the exception queue
-- (never silently dropped, never auto-invoiced; brief section 5/9).
create or replace function app.payroll_missing_invoice_pets(p_org uuid, p_period_start date, p_period_end date)
returns table(grooming_job_pet_id uuid, booking_id uuid, membership_id uuid, pet_id uuid, starts_at timestamptz)
security definer set search_path = app, public
language sql stable as $$
  select gjp.id, gjp.grooming_job_id, r.membership_id, gjp.pet_id, b.starts_at
  from public.grooming_job_pets gjp
  join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
  join public.resources r on r.organization_id = gjp.organization_id and r.id = gjp.assigned_resource_id and r.membership_id is not null
  where gjp.organization_id = p_org and gjp.deleted_at is null and gjp.status = 'complete'
    and (b.starts_at at time zone app.org_timezone(p_org))::date >= p_period_start
    and (b.starts_at at time zone app.org_timezone(p_org))::date < p_period_end
    and not exists (
      select 1 from public.orders ord
      join public.invoices inv on inv.organization_id = ord.organization_id and inv.order_id = ord.id
      where ord.organization_id = b.organization_id and ord.booking_id = b.id and ord.deleted_at is null
        and inv.status <> 'void'
    );
$$;

revoke all on function app.payroll_missing_invoice_pets(uuid, date, date) from public;
grant execute on function app.payroll_missing_invoice_pets(uuid, date, date) to authenticated;

-- =====================================================================
-- SECTION 4 — Transport half-share, split so shares never exceed the pool
-- (fixes the HomePaw bug where N groomers on one booking each independently
-- receive round(fee/2), so the total scales with N instead of being capped
-- at the fee -- see calculation contract 5.5).
-- =====================================================================
create or replace function app.payroll_transport_shares(p_org uuid, p_period_start date, p_period_end date)
returns table(membership_id uuid, transport_total numeric)
security definer set search_path = app, public
language sql stable as $$
  with booking_pool as (
    select b.id as booking_id, round(b.travel_fee / 2, 2) as half_pool
    from public.bookings b
    where b.organization_id = p_org and b.fulfillment_mode = 'home' and coalesce(b.travel_fee, 0) > 0
      and (b.starts_at at time zone app.org_timezone(p_org))::date >= p_period_start
      and (b.starts_at at time zone app.org_timezone(p_org))::date < p_period_end
  ),
  booking_groomers as (
    select distinct ep.booking_id, ep.membership_id
    from app.payroll_eligible_pets(p_org, p_period_start, p_period_end) ep
    where ep.booking_id in (select booking_id from booking_pool)
  ),
  counted as (
    select bg.booking_id, bg.membership_id,
      count(*) over (partition by bg.booking_id) as n,
      row_number() over (partition by bg.booking_id order by bg.membership_id) as rn
    from booking_groomers bg
  ),
  shares as (
    select c.booking_id, c.membership_id,
      floor(bp.half_pool / c.n) + (case when c.rn = 1 then bp.half_pool - floor(bp.half_pool / c.n) * c.n else 0 end) as share
    from counted c join booking_pool bp on bp.booking_id = c.booking_id
  )
  select membership_id, sum(share) from shares group by membership_id;
$$;

revoke all on function app.payroll_transport_shares(uuid, date, date) from public;
grant execute on function app.payroll_transport_shares(uuid, date, date) to authenticated;

-- =====================================================================
-- SECTION 5 — compute_payroll_item: pure, side-effect-free computation of
-- one membership's breakdown for one period (calculation contract 5.5).
-- Deliberately does NOT read payroll_item_overrides/payroll_custom_rows --
-- those are applied by the caller (recompute_payroll_run), keeping this
-- function independently testable with crafted fixtures (brief section 10).
-- =====================================================================
create or replace function app.compute_payroll_item(p_org uuid, p_membership uuid, p_period_start date, p_period_end date)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org_settings public.payroll_cycle_settings%rowtype;
  v_settings public.staff_payroll_settings%rowtype;
  v_basic numeric(14,2) := 0;
  v_day_stats jsonb;
  v_weekly numeric(14,2) := 0;
  v_no_late numeric(14,2) := 0;
  v_no_sick numeric(14,2) := 0;
  v_late_count int := 0;
  v_basic_count int := 0; v_botak_count int := 0; v_styling_count int := 0;
  v_styling_revenue numeric(14,2) := 0;
  v_botak_rate numeric(14,2); v_botak_amount numeric(14,2) := 0;
  v_tiers jsonb; v_styling_pct numeric := 0; v_styling_amount numeric(14,2) := 0;
  v_transport numeric(14,2) := 0;
  v_daily numeric(14,2) := 0;
  v_matrix jsonb; v_per_pet_rate numeric(14,2); v_basic_amount numeric(14,2) := 0;
  r record;
begin
  select * into v_org_settings from public.payroll_cycle_settings where organization_id = p_org;
  if not found then
    raise exception 'payroll_cycle_settings_missing:%', p_org using errcode = 'no_data_found';
  end if;
  select * into v_settings from public.staff_payroll_settings where organization_id = p_org and membership_id = p_membership;

  select coalesce(sc.base_amount, 0) into v_basic
  from public.staff_compensation sc
  where sc.organization_id = p_org and sc.membership_id = p_membership and sc.is_active and sc.deleted_at is null
    and sc.effective_from <= (p_period_end - 1)
  order by sc.effective_from desc limit 1;
  v_basic := coalesce(v_basic, 0);

  v_day_stats := app.payroll_working_day_stats(p_org, p_membership, p_period_start, p_period_end);

  if coalesce(v_settings.weekly_salary_enabled, false) then
    v_weekly := round(coalesce(v_settings.weekly_salary_amount, v_org_settings.weekly_salary_amount_default) / 6.0
                * (v_day_stats ->> 'weekly_paid_days')::int, 2);
  end if;

  if coalesce(v_settings.no_late_enabled, false) then
    select count(*) into v_late_count
    from public.attendance_records ar
    join public.bookings b on b.organization_id = ar.organization_id and b.id = ar.booking_id
    where ar.organization_id = p_org and ar.membership_id = p_membership and ar.deleted_at is null
      and ar.classification = 'late' and ar.waived_at is null
      and (b.starts_at at time zone app.org_timezone(p_org))::date >= p_period_start
      and (b.starts_at at time zone app.org_timezone(p_org))::date < p_period_end;
    v_no_late := case when v_late_count = 0 then coalesce(v_settings.no_late_amount, v_org_settings.no_late_amount_default) else 0 end;
  end if;

  if coalesce(v_settings.no_sick_enabled, false) then
    v_no_sick := case when (v_day_stats ->> 'sick_days')::int = 0
      then coalesce(v_settings.no_sick_amount, v_org_settings.no_sick_amount_default) else 0 end;
  end if;

  select count(*) filter (where has_basic), count(*) filter (where has_botak), count(*) filter (where has_styling),
         coalesce(sum(styling_revenue) filter (where has_styling), 0)
    into v_basic_count, v_botak_count, v_styling_count, v_styling_revenue
  from app.payroll_eligible_pets(p_org, p_period_start, p_period_end) ep
  where ep.membership_id = p_membership;

  v_matrix := coalesce(v_settings.per_pet_size_matrix, v_org_settings.per_pet_size_matrix_default, '{}'::jsonb);
  v_per_pet_rate := coalesce(v_settings.per_pet_amount, v_org_settings.per_pet_amount_default);
  if coalesce(v_settings.per_pet_enabled, true) and v_basic_count > 0 then
    for r in
      select pt.size, count(*) as n
      from app.payroll_eligible_pets(p_org, p_period_start, p_period_end) ep
      join public.pets pt on pt.organization_id = p_org and pt.id = ep.pet_id
      where ep.membership_id = p_membership and ep.has_basic
      group by pt.size
    loop
      if r.size is not null and (v_matrix ? r.size) then
        -- coalesce guards a malformed/null matrix entry (e.g. {"small": null})
        -- from NULL-poisoning v_basic_amount for every subsequent size group
        -- in this loop -- falls back to the flat rate for that group only,
        -- instead of silently zeroing every other pet's per-pet pay too.
        v_basic_amount := v_basic_amount + coalesce((v_matrix ->> r.size)::numeric, v_per_pet_rate) * r.n;
      else
        v_basic_amount := v_basic_amount + v_per_pet_rate * r.n;
      end if;
    end loop;
  end if;

  v_botak_rate := coalesce(v_settings.botak_amount, v_org_settings.botak_amount_default);
  v_botak_amount := case when coalesce(v_settings.botak_enabled, true) and v_botak_count > 0
    then v_botak_rate * v_botak_count else 0 end;

  v_tiers := coalesce(nullif(v_settings.styling_tiers, '[]'::jsonb), v_org_settings.styling_tiers_default);
  if coalesce(v_settings.styling_enabled, false) then
    select coalesce(max((t ->> 'pct')::numeric), 0) into v_styling_pct
    from jsonb_array_elements(v_tiers) t
    where (t ->> 'min_jobs')::int <= v_styling_count;
  end if;
  v_styling_amount := round(v_styling_revenue * v_styling_pct / 100.0, 2);

  select coalesce(ts.transport_total, 0) into v_transport
  from app.payroll_transport_shares(p_org, p_period_start, p_period_end) ts
  where ts.membership_id = p_membership;
  v_transport := coalesce(v_transport, 0);

  if coalesce(v_settings.daily_enabled, false) then
    v_daily := coalesce(v_settings.daily_amount, v_org_settings.daily_amount_default) * (v_day_stats ->> 'worked')::int;
  end if;

  return jsonb_build_object(
    'basic', v_basic, 'weekly', v_weekly, 'noLate', v_no_late, 'noSick', v_no_sick,
    'styling', v_styling_amount, 'botak', v_botak_amount, 'transport', v_transport,
    'perDog', v_basic_amount, 'daily', v_daily,
    'meta', jsonb_build_object(
      'stylingCount', v_styling_count, 'stylingRevenue', v_styling_revenue, 'stylingAppliedPct', v_styling_pct,
      'botakCount', v_botak_count, 'basicCount', v_basic_count, 'lateCount', v_late_count,
      'sickDays', (v_day_stats ->> 'sick_days')::int, 'scheduledDays', (v_day_stats ->> 'scheduled')::int,
      'workedDays', (v_day_stats ->> 'worked')::int, 'weeklyPaidDays', (v_day_stats ->> 'weekly_paid_days')::int,
      'calculationVersion', 1
    )
  );
end; $$;

revoke all on function app.compute_payroll_item(uuid, uuid, date, date) from public;
grant execute on function app.compute_payroll_item(uuid, uuid, date, date) to authenticated;

-- =====================================================================
-- SECTION 6 — recompute_payroll_run: the single, atomic, server-side
-- replacement for pilot-actions.ts's non-atomic client delete+insert loop.
-- Locks the run row first (serializes concurrent recompute/approve/pay),
-- refuses once the run has left 'draft', applies persisted overrides and
-- custom rows on top of the fresh computation (5.9 -- these survive
-- recompute because this function only ever READS them).
-- =====================================================================
create or replace function app.recompute_payroll_run(p_period_start date, p_period_end date, p_branch uuid default null)
returns uuid
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid := app.fn_active_organization();
  v_run_id uuid;
  v_status text;
  v_currency text;
  m record;
  v_breakdown jsonb;
  v_override record;
  v_custom_total numeric(14,2);
  v_gross numeric(14,2); v_total_gross numeric(14,2) := 0; v_total_net numeric(14,2) := 0;
begin
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', p_branch);
  if p_period_end <= p_period_start then
    raise exception 'invalid_period' using errcode = 'check_violation';
  end if;

  insert into public.payroll_cycle_settings (organization_id)
  values (v_org) on conflict (organization_id) do nothing;

  select id, status, currency into v_run_id, v_status, v_currency from public.payroll_runs
  where organization_id = v_org and coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(p_branch, '00000000-0000-0000-0000-000000000000'::uuid)
    and period_start = p_period_start and period_end = p_period_end
  for update;

  if v_run_id is null then
    -- payroll_runs.currency defaults to 'USD' (0009's original default, written
    -- before this engine existed); a run must instead carry the ORG's real
    -- currency, not that placeholder, since it flows straight into the
    -- financial_ledger entry tg_payroll_ledger writes on pay. Prefer the org's
    -- own declared currency (organizations.settings->>'currency'); fall back to
    -- whatever currency its active staff_compensation rows actually use (the
    -- most common one) when the org never set one; fall back to the table
    -- default only if neither source exists.
    select coalesce(
      (select o.settings ->> 'currency' from public.organizations o where o.id = v_org),
      (select sc.currency from public.staff_compensation sc
       where sc.organization_id = v_org and sc.is_active and sc.deleted_at is null
       group by sc.currency order by count(*) desc limit 1),
      'USD'
    ) into v_currency;
    insert into public.payroll_runs (organization_id, branch_id, period_start, period_end, status, currency)
    values (v_org, p_branch, p_period_start, p_period_end, 'draft', v_currency)
    returning id, status into v_run_id, v_status;
  elsif v_status <> 'draft' then
    raise exception 'run_not_editable:%', v_status using errcode = 'check_violation';
  end if;

  delete from public.payroll_items where organization_id = v_org and payroll_run_id = v_run_id;

  for m in
    select sc.membership_id, sc.currency
    from public.staff_compensation sc
    where sc.organization_id = v_org and sc.is_active and sc.deleted_at is null
      and sc.effective_from <= (p_period_end - 1)
    group by sc.membership_id, sc.currency
  loop
    -- Brief requirement: never sum unlike currencies into an unlabeled total.
    -- A membership paid in a currency other than the run's is a real
    -- configuration problem, not something to silently add together.
    if m.currency <> v_currency then
      raise exception 'currency_mismatch:membership=% run_currency=% staff_currency=%', m.membership_id, v_currency, m.currency
        using errcode = 'check_violation';
    end if;
    v_breakdown := app.compute_payroll_item(v_org, m.membership_id, p_period_start, p_period_end);

    for v_override in
      select component_key, amount from public.payroll_item_overrides
      where organization_id = v_org and payroll_run_id = v_run_id and membership_id = m.membership_id
    loop
      v_breakdown := jsonb_set(v_breakdown, array[v_override.component_key], to_jsonb(v_override.amount));
    end loop;

    select coalesce(sum(amount), 0) into v_custom_total
    from public.payroll_custom_rows
    where organization_id = v_org and payroll_run_id = v_run_id and membership_id = m.membership_id and deleted_at is null;

    v_gross := coalesce((v_breakdown->>'basic')::numeric,0) + coalesce((v_breakdown->>'weekly')::numeric,0)
      + coalesce((v_breakdown->>'noLate')::numeric,0) + coalesce((v_breakdown->>'noSick')::numeric,0)
      + coalesce((v_breakdown->>'styling')::numeric,0) + coalesce((v_breakdown->>'botak')::numeric,0)
      + coalesce((v_breakdown->>'transport')::numeric,0) + coalesce((v_breakdown->>'perDog')::numeric,0)
      + coalesce((v_breakdown->>'daily')::numeric,0) + v_custom_total;

    insert into public.payroll_items
      (organization_id, payroll_run_id, membership_id, base_pay, commission_total, gross_pay, net_pay, breakdown)
    values (v_org, v_run_id, m.membership_id, coalesce((v_breakdown->>'basic')::numeric,0),
      coalesce((v_breakdown->>'styling')::numeric,0) + coalesce((v_breakdown->>'botak')::numeric,0),
      v_gross, v_gross, v_breakdown);

    v_total_gross := v_total_gross + v_gross;
    v_total_net := v_total_net + v_gross;
  end loop;

  update public.payroll_runs set total_gross = v_total_gross, total_net = v_total_net, revision = revision + 1
  where organization_id = v_org and id = v_run_id;

  return v_run_id;
end; $$;

revoke all on function app.recompute_payroll_run(date, date, uuid) from public;
grant execute on function app.recompute_payroll_run(date, date, uuid) to authenticated;

-- =====================================================================
-- SECTION 7 — approve / pay / undo. Row-locked on payroll_runs; each
-- checks a natural state transition and no-ops (returns current state) if
-- already applied, matching this codebase's established idempotency
-- pattern (see the note at the end of 20261001100000).
-- =====================================================================
create or replace function app.approve_payroll_run(p_run_id uuid)
returns public.payroll_runs
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_run public.payroll_runs%rowtype;
begin
  select * into v_run from public.payroll_runs where organization_id = v_org and id = p_run_id for update;
  if not found then raise exception 'run_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.approve', v_run.branch_id);
  if v_run.status = 'approved' or v_run.status = 'paid' then
    return v_run; -- idempotent: already applied
  end if;
  if v_run.status <> 'draft' then
    raise exception 'run_not_approvable:%', v_run.status using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.payroll_items where organization_id = v_org and payroll_run_id = p_run_id) then
    raise exception 'run_has_no_items' using errcode = 'check_violation';
  end if;
  update public.payroll_runs set status = 'approved', approved_at = now(), revision = revision + 1
   where organization_id = v_org and id = p_run_id
   returning * into v_run;
  return v_run;
end; $$;

create or replace function app.pay_payroll_run(p_run_id uuid)
returns public.payroll_runs
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_run public.payroll_runs%rowtype;
begin
  select * into v_run from public.payroll_runs where organization_id = v_org and id = p_run_id for update;
  if not found then raise exception 'run_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.approve', v_run.branch_id);
  if v_run.status = 'paid' then
    return v_run; -- idempotent: already applied
  end if;
  if v_run.status <> 'approved' then
    raise exception 'run_not_payable:%', v_run.status using errcode = 'check_violation';
  end if;
  update public.payroll_runs set status = 'paid', paid_at = now(), revision = revision + 1
   where organization_id = v_org and id = p_run_id
   returning * into v_run;
  return v_run;
end; $$;

-- Auditable reversal: NEVER deletes payroll_items/payroll_runs history and
-- never flips paid->draft. Moves the run to 'draft' only after recording a
-- reversal ledger entry via financial_ledger (compensating +total_net entry,
-- mirroring tg_payroll_ledger's own -total_net entry at pay time) and an
-- explicit correction marker in payroll_runs.metadata, so a report can never
-- silently double-count the original payout and the corrected redraft.
-- Replaces HomePaw's hard DELETE of the paid row (verified: no audit trail,
-- no history -- see the calculation contract's lifecycle research notes).
create or replace function app.undo_payroll_payment(p_run_id uuid, p_reason text)
returns public.payroll_runs
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_run public.payroll_runs%rowtype; v_corrections int;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  select * into v_run from public.payroll_runs where organization_id = v_org and id = p_run_id for update;
  if not found then raise exception 'run_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.approve', v_run.branch_id);
  v_corrections := coalesce((v_run.metadata->>'correction_count')::int, 0);
  if v_run.status = 'draft' then
    return v_run; -- idempotent: nothing to undo
  end if;
  if v_run.status <> 'paid' then
    raise exception 'run_not_undoable:%', v_run.status using errcode = 'check_violation';
  end if;

  -- Compensating ledger entry (reverses tg_payroll_ledger's -total_net 'payroll_paid' row).
  insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, payroll_run_id, occurred_at)
  values (v_org, v_run.branch_id, 'payroll_paid', v_run.total_net, v_run.currency, v_run.id, now());

  update public.payroll_runs set
    status = 'draft', approved_at = null, paid_at = null, revision = revision + 1,
    metadata = v_run.metadata || jsonb_build_object(
      'correction_count', v_corrections + 1,
      'last_reversal', jsonb_build_object('reason', p_reason, 'reversed_at', now(), 'reversed_by', app.fn_current_user_id(),
        'original_total_net', v_run.total_net, 'original_paid_at', v_run.paid_at))
  where organization_id = v_org and id = p_run_id
  returning * into v_run;

  -- The prior paid snapshot's payroll_items rows are left exactly as they
  -- were (frozen, never deleted) as the historical record of the original
  -- payout; a subsequent recompute produces a NEW set of items for the same
  -- run once it is draft again, and the run's `revision` + `metadata` above
  -- are what let a report distinguish "the original payout" from
  -- "the corrected redraft" without double-counting either.
  return v_run;
end; $$;

revoke all on function app.approve_payroll_run(uuid), app.pay_payroll_run(uuid), app.undo_payroll_payment(uuid, text) from public;
grant execute on function app.approve_payroll_run(uuid), app.pay_payroll_run(uuid), app.undo_payroll_payment(uuid, text) to authenticated;

-- =====================================================================
-- SECTION 8 — Draft-only edits: overrides and custom rows. Both check the
-- run is still 'draft' server-side (the brief's "server authorization and
-- revision guards" requirement) instead of relying on the client to hide
-- the edit UI once paid.
-- =====================================================================
create or replace function app.set_payroll_item_override(p_run_id uuid, p_membership uuid, p_component text, p_amount numeric, p_reason text)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_status text; v_branch uuid;
begin
  select status, branch_id into v_status, v_branch from public.payroll_runs where organization_id = v_org and id = p_run_id for update;
  if not found then raise exception 'run_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', v_branch);
  if v_status <> 'draft' then raise exception 'run_not_editable:%', v_status using errcode = 'check_violation'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'invalid_amount' using errcode = 'check_violation'; end if;

  insert into public.payroll_item_overrides (organization_id, payroll_run_id, membership_id, component_key, amount, reason)
  values (v_org, p_run_id, p_membership, p_component, p_amount, p_reason)
  on conflict (organization_id, payroll_run_id, membership_id, component_key)
  do update set amount = excluded.amount, reason = excluded.reason, updated_at = now();

  perform app.recompute_payroll_run(
    (select period_start from public.payroll_runs where organization_id = v_org and id = p_run_id),
    (select period_end from public.payroll_runs where organization_id = v_org and id = p_run_id),
    v_branch);
end; $$;

create or replace function app.clear_payroll_item_override(p_run_id uuid, p_membership uuid, p_component text)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_status text; v_branch uuid;
begin
  select status, branch_id into v_status, v_branch from public.payroll_runs where organization_id = v_org and id = p_run_id for update;
  if not found then raise exception 'run_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', v_branch);
  if v_status <> 'draft' then raise exception 'run_not_editable:%', v_status using errcode = 'check_violation'; end if;

  delete from public.payroll_item_overrides
  where organization_id = v_org and payroll_run_id = p_run_id and membership_id = p_membership and component_key = p_component;

  perform app.recompute_payroll_run(
    (select period_start from public.payroll_runs where organization_id = v_org and id = p_run_id),
    (select period_end from public.payroll_runs where organization_id = v_org and id = p_run_id),
    v_branch);
end; $$;

create or replace function app.upsert_payroll_custom_row(p_run_id uuid, p_row_id uuid, p_membership uuid, p_label text, p_amount numeric, p_sort_order integer default 0)
returns uuid
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_status text; v_branch uuid; v_id uuid;
begin
  select status, branch_id into v_status, v_branch from public.payroll_runs where organization_id = v_org and id = p_run_id for update;
  if not found then raise exception 'run_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', v_branch);
  if v_status <> 'draft' then raise exception 'run_not_editable:%', v_status using errcode = 'check_violation'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'invalid_amount' using errcode = 'check_violation'; end if;

  if p_row_id is null then
    insert into public.payroll_custom_rows (organization_id, payroll_run_id, membership_id, label, amount, sort_order)
    values (v_org, p_run_id, p_membership, coalesce(p_label, ''), p_amount, p_sort_order)
    returning id into v_id;
  else
    update public.payroll_custom_rows set label = coalesce(p_label, ''), amount = p_amount, sort_order = p_sort_order, updated_at = now()
    where organization_id = v_org and id = p_row_id and payroll_run_id = p_run_id and deleted_at is null
    returning id into v_id;
    if v_id is null then raise exception 'custom_row_not_found' using errcode = 'no_data_found'; end if;
  end if;

  perform app.recompute_payroll_run(
    (select period_start from public.payroll_runs where organization_id = v_org and id = p_run_id),
    (select period_end from public.payroll_runs where organization_id = v_org and id = p_run_id),
    v_branch);
  return v_id;
end; $$;

create or replace function app.delete_payroll_custom_row(p_run_id uuid, p_row_id uuid)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_status text; v_branch uuid;
begin
  select status, branch_id into v_status, v_branch from public.payroll_runs where organization_id = v_org and id = p_run_id for update;
  if not found then raise exception 'run_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', v_branch);
  if v_status <> 'draft' then raise exception 'run_not_editable:%', v_status using errcode = 'check_violation'; end if;

  update public.payroll_custom_rows set deleted_at = now()
  where organization_id = v_org and id = p_row_id and payroll_run_id = p_run_id;

  perform app.recompute_payroll_run(
    (select period_start from public.payroll_runs where organization_id = v_org and id = p_run_id),
    (select period_end from public.payroll_runs where organization_id = v_org and id = p_run_id),
    v_branch);
end; $$;

revoke all on function app.set_payroll_item_override(uuid, uuid, text, numeric, text),
  app.clear_payroll_item_override(uuid, uuid, text),
  app.upsert_payroll_custom_row(uuid, uuid, uuid, text, numeric, integer),
  app.delete_payroll_custom_row(uuid, uuid) from public;
grant execute on function app.set_payroll_item_override(uuid, uuid, text, numeric, text),
  app.clear_payroll_item_override(uuid, uuid, text),
  app.upsert_payroll_custom_row(uuid, uuid, uuid, text, numeric, integer),
  app.delete_payroll_custom_row(uuid, uuid) to authenticated;

-- =====================================================================
-- SECTION 9 — Retention deposit payout. One-time lump sum (5.7): the
-- unique index uidx_pre_one_payout_per_member is the natural idempotency
-- boundary -- a second attempt hits unique_violation, which this function
-- catches and treats as an idempotent success (returns the existing
-- payout event) rather than surfacing a raw constraint error.
-- =====================================================================
create or replace function app.pay_retention_deposit(p_membership uuid)
returns public.payroll_retention_events
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid := app.fn_active_organization();
  v_settings public.staff_payroll_settings%rowtype; v_org_settings public.payroll_cycle_settings%rowtype;
  v_hired_at date; v_tenure int; v_term int; v_amount_per_month numeric(14,2);
  v_balance numeric(14,2); v_event public.payroll_retention_events%rowtype;
begin
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.approve', null);

  select hired_at into v_hired_at from public.resources
  where organization_id = v_org and membership_id = p_membership and kind = 'staff' and deleted_at is null
  order by created_at limit 1;
  if v_hired_at is null then raise exception 'no_hire_date_on_record' using errcode = 'check_violation'; end if;

  select * into v_settings from public.staff_payroll_settings where organization_id = v_org and membership_id = p_membership;
  select * into v_org_settings from public.payroll_cycle_settings where organization_id = v_org;
  if not coalesce(v_settings.retention_enabled, false) then
    raise exception 'retention_not_enabled_for_member' using errcode = 'check_violation';
  end if;

  v_term := coalesce(v_settings.retention_term_months, v_org_settings.retention_term_months_default);
  v_amount_per_month := coalesce(v_settings.retention_amount_per_month, v_org_settings.retention_amount_per_month_default);
  v_tenure := greatest(0, (extract(year from age(app.org_today(v_org), v_hired_at)) * 12
    + extract(month from age(app.org_today(v_org), v_hired_at)))::int);

  if v_tenure < v_term then
    raise exception 'retention_not_yet_payable:tenure=% term=%', v_tenure, v_term using errcode = 'check_violation';
  end if;
  v_balance := least(v_term, v_tenure) * v_amount_per_month;

  begin
    insert into public.payroll_retention_events (organization_id, membership_id, kind, amount, tenure_months, metadata)
    values (v_org, p_membership, 'payout', v_balance, v_tenure, jsonb_build_object('term_months', v_term, 'amount_per_month', v_amount_per_month))
    returning * into v_event;
  exception when unique_violation then
    select * into v_event from public.payroll_retention_events
    where organization_id = v_org and membership_id = p_membership and kind = 'payout';
  end;

  insert into public.financial_ledger (organization_id, entry_type, amount, currency, occurred_at)
  select v_org, 'payroll_paid', -v_event.amount, coalesce(sc.currency, 'USD'), v_event.occurred_at
  from public.staff_compensation sc where sc.organization_id = v_org and sc.membership_id = p_membership and sc.is_active
  limit 1;

  return v_event;
end; $$;

revoke all on function app.pay_retention_deposit(uuid) from public;
grant execute on function app.pay_retention_deposit(uuid) to authenticated;

-- =====================================================================
-- SECTION 10 — Publish / unpublish / read own snapshot. Unlike HomePaw's
-- denormalized JSONB copy on the groomers table (which goes stale after an
-- undo because unmarkGroomerPaid never republishes -- verified in the
-- lifecycle research), this points at the live payroll_run_id/membership_id
-- and reads payroll_items fresh on every call, so hiding or an undo takes
-- effect immediately with no republish step.
-- =====================================================================
create or replace function app.publish_payroll_snapshot(p_run_id uuid, p_membership uuid)
returns public.payroll_publications
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization(); v_branch uuid; v_row public.payroll_publications%rowtype;
begin
  select branch_id into v_branch from public.payroll_runs where organization_id = v_org and id = p_run_id;
  if v_branch is null and not exists (select 1 from public.payroll_runs where organization_id = v_org and id = p_run_id) then
    raise exception 'run_not_found' using errcode = 'no_data_found';
  end if;
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', v_branch);
  if not exists (select 1 from public.payroll_items where organization_id = v_org and payroll_run_id = p_run_id and membership_id = p_membership) then
    raise exception 'no_payroll_item_for_member' using errcode = 'check_violation';
  end if;

  insert into public.payroll_publications (organization_id, membership_id, payroll_run_id, enabled, published_by)
  values (v_org, p_membership, p_run_id, true, app.fn_current_user_id())
  on conflict (organization_id, membership_id)
  do update set payroll_run_id = excluded.payroll_run_id, enabled = true, published_at = now(), published_by = excluded.published_by, updated_at = now()
  returning * into v_row;
  return v_row;
end; $$;

create or replace function app.unpublish_payroll_snapshot(p_membership uuid)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid := app.fn_active_organization();
begin
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', null);
  update public.payroll_publications set enabled = false, updated_at = now()
  where organization_id = v_org and membership_id = p_membership;
end; $$;

-- Groomer's own read of their currently published snapshot. Runs as
-- definer specifically so a groomer (who holds no payroll.read permission)
-- can read their OWN row without a broader grant on payroll_runs/items --
-- enabled is checked live on every call, so hide/undo is immediate.
create or replace function app.get_my_payroll_snapshot()
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid := app.fn_active_organization();
  v_membership uuid;
  v_name text;
  v_pub public.payroll_publications%rowtype;
  v_run public.payroll_runs%rowtype;
  v_item public.payroll_items%rowtype;
begin
  select m.id, coalesce(u.full_name, u.email, 'Staf') into v_membership, v_name
  from public.memberships m join public.users u on u.id = m.user_id
  where m.organization_id = v_org and m.user_id = auth.uid() and m.status = 'active' and m.deleted_at is null;
  if v_membership is null then return null; end if;

  select * into v_pub from public.payroll_publications where organization_id = v_org and membership_id = v_membership;
  if not found or not v_pub.enabled then return null; end if;

  select * into v_run from public.payroll_runs where organization_id = v_org and id = v_pub.payroll_run_id;
  select * into v_item from public.payroll_items where organization_id = v_org and payroll_run_id = v_pub.payroll_run_id and membership_id = v_membership;
  if v_run.id is null or v_item.id is null then return null; end if;

  return jsonb_build_object(
    'staffName', v_name,
    'status', v_run.status, 'periodStart', v_run.period_start, 'periodEnd', v_run.period_end,
    'publishedAt', v_pub.published_at, 'breakdown', v_item.breakdown, 'total', v_item.gross_pay,
    'customRows', coalesce((
      select jsonb_agg(jsonb_build_object('label', label, 'amount', amount) order by sort_order)
      from public.payroll_custom_rows
      where organization_id = v_org and payroll_run_id = v_pub.payroll_run_id and membership_id = v_membership and deleted_at is null
    ), '[]'::jsonb)
  );
end; $$;

revoke all on function app.publish_payroll_snapshot(uuid, uuid), app.unpublish_payroll_snapshot(uuid), app.get_my_payroll_snapshot() from public;
grant execute on function app.publish_payroll_snapshot(uuid, uuid), app.unpublish_payroll_snapshot(uuid), app.get_my_payroll_snapshot() to authenticated;

-- =====================================================================
-- SECTION 11 — RLS: base permissive org-isolation (0010 pattern -- these 7
-- tables are new, so 0010's static per-table list can't cover them; adding
-- the identical policy shape here is additive, not a rewrite of that
-- historical migration) PLUS restrictive capability policies (0011
-- pattern) for every table added in 20261001100000.
-- =====================================================================

-- Base permissive layer: org match + active membership (0010 SECTION 004's
-- "org-scoped, no branch gate" shape -- none of these 7 tables are
-- branch-scoped columns themselves; branch authorization for the
-- mutating RPCs is enforced separately via assert_tenant_authorized).
do $$
declare t text;
begin
  foreach t in array array[
    'payroll_cycle_settings','staff_payroll_settings','payroll_item_overrides',
    'payroll_custom_rows','payroll_retention_events','payroll_publications']
  loop
    execute format($f$
      create policy %1$s_org_isolation on public.%1$s for all
      using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()))
      with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()));
    $f$, t);
  end loop;
end $$;

-- Restrictive layer, config tables (direct payroll.manage write is fine --
-- no financial-effect / draft-state invariant to protect here).
do $$
declare r record; wcheck text;
begin
  for r in
    select * from (values
      ('payroll_cycle_settings', 'payroll', 'payroll.read', 'payroll.manage'),
      ('staff_payroll_settings', 'payroll', 'payroll.read', 'payroll.manage')
    ) as m(tbl, module, rperm, wperm)
  loop
    execute format($f$
      create policy %1$s_module_gate on public.%1$s as restrictive for all
      using (app.is_platform_admin() or app.has_module(%2$L))
      with check (app.is_platform_admin() or app.has_module(%2$L));
    $f$, r.tbl, r.module);
    execute format($f$
      create policy %1$s_read_cap on public.%1$s as restrictive for select
      using (app.is_platform_admin() or app.has_permission(%2$L));
    $f$, r.tbl, r.rperm);
    wcheck := format('(app.is_platform_admin() or app.has_permission(%L))', r.wperm);
    execute format('create policy %1$s_write_ins on public.%1$s as restrictive for insert with check (%2$s);', r.tbl, wcheck);
    execute format('create policy %1$s_write_upd on public.%1$s as restrictive for update using (%2$s) with check (%2$s);', r.tbl, wcheck);
    execute format('create policy %1$s_write_del on public.%1$s as restrictive for delete using (%2$s);', r.tbl, wcheck);
  end loop;

  -- RPC-only tables: module gate + read capability + an ADMIN-ONLY
  -- restrictive write policy (mirrors payroll_items/financial_ledger's
  -- existing admin_write=true rows in 0011 exactly -- restrictive policies
  -- are AND-ed, so leaving write ungated here would let the base permissive
  -- layer's own INSERT/UPDATE/DELETE through for any org member; this row
  -- is what actually makes these RPC-only for ordinary users, since the
  -- SECURITY DEFINER functions above bypass RLS entirely as table owner).
  for r in
    select * from (values
      ('payroll_item_overrides', 'payroll', 'payroll.read'),
      ('payroll_custom_rows', 'payroll', 'payroll.read'),
      ('payroll_retention_events', 'payroll', 'payroll.read'),
      ('payroll_publications', 'payroll', 'payroll.read')
    ) as m(tbl, module, rperm)
  loop
    execute format($f$
      create policy %1$s_module_gate on public.%1$s as restrictive for all
      using (app.is_platform_admin() or app.has_module(%2$L))
      with check (app.is_platform_admin() or app.has_module(%2$L));
    $f$, r.tbl, r.module);
    execute format($f$
      create policy %1$s_read_cap on public.%1$s as restrictive for select
      using (app.is_platform_admin() or app.has_permission(%2$L));
    $f$, r.tbl, r.rperm);
    execute format('create policy %1$s_write_ins_admin on public.%1$s as restrictive for insert with check (app.is_platform_admin());', r.tbl);
    execute format('create policy %1$s_write_upd_admin on public.%1$s as restrictive for update using (app.is_platform_admin()) with check (app.is_platform_admin());', r.tbl);
    execute format('create policy %1$s_write_del_admin on public.%1$s as restrictive for delete using (app.is_platform_admin());', r.tbl);
  end loop;
end $$;

-- Tighten the two EXISTING tables this feature builds on. 0011 (frozen)
-- gates payroll_runs/payroll_items direct writes on the 'payroll.approve'
-- permission alone -- any holder of that permission could otherwise
-- directly UPDATE payroll_runs.status (e.g. paid -> draft with no
-- compensating ledger entry, no reason, no audit) or INSERT payroll_items
-- rows bypassing every guard in the RPCs above. Restrictive policies are
-- AND-ed, so ADDING an admin-only restrictive write policy here (without
-- touching 0011's own policy, consistent with "do not rewrite applied
-- migrations") makes ordinary direct writes to these two tables impossible
-- for anyone but a platform admin, closing exactly the gap the brief warns
-- about, while every SECURITY DEFINER function above still works (it runs
-- as table owner and bypasses RLS regardless of any policy).
create policy payroll_runs_write_ins_admin on public.payroll_runs as restrictive for insert with check (app.is_platform_admin());
create policy payroll_runs_write_upd_admin on public.payroll_runs as restrictive for update using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy payroll_runs_write_del_admin on public.payroll_runs as restrictive for delete using (app.is_platform_admin());
create policy payroll_items_write_ins_admin on public.payroll_items as restrictive for insert with check (app.is_platform_admin());
create policy payroll_items_write_upd_admin on public.payroll_items as restrictive for update using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy payroll_items_write_del_admin on public.payroll_items as restrictive for delete using (app.is_platform_admin());

-- payroll_publications additionally lets a groomer read their OWN row
-- directly (needed so my-schedule can show "is my payroll published"
-- without a round trip through the SECURITY DEFINER snapshot RPC) -- this
-- is a second PERMISSIVE select policy, OR'd with the base org-isolation
-- one above; the admin-only restrictive write policy from the loop still
-- applies to every command, so this never opens a write path.
create policy payroll_publications_read_self on public.payroll_publications for select
  using (organization_id = app.fn_active_organization() and membership_id in (
    select m.id from public.memberships m where m.organization_id = app.fn_active_organization()
      and m.user_id = auth.uid() and m.status = 'active' and m.deleted_at is null));

notify pgrst, 'reload schema';
commit;
