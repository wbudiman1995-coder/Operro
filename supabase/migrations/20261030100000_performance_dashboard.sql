-- Decision-ready performance dashboard (read-only).
--
-- 1. Dashboard card visibility gains three organization-owned keys: performance_operations,
--    performance_finance, performance_sources. A legacy four-key payload stays valid and leaves any stored
--    value of the new keys untouched (an absent value means "visible" in the application).
-- 2. Three bounded, read-only aggregates. Each one:
--      - takes the organization ONLY from the authenticated session (app.fn_active_organization), never an argument;
--      - checks membership, the exact capability and the module gate the underlying tables' policies require, and
--        refuses with 42501 (a loud error, never an RLS-emptied zero);
--      - resolves the caller's visible branches ONCE (branches.all, else membership_branch_access) and filters every
--        branch-owned table with it - the same rule as app.has_branch;
--      - returns counts / sums only: no customer identity, contact data, notes, proof or file reference;
--      - never sums across currencies.
--    WHY SECURITY DEFINER (deliberate deviation from the "invoker" plan, measured on PostgreSQL 16 with 200k bookings,
--    120k invoices, 72k payments): app.has_branch costs ~0.84 ms per call and the branch row-level-security policy
--    evaluates it per scanned row, so an invoker aggregate costs ~0.84 ms x rows-in-window (a 30-day window of a busy
--    salon: seconds; 366 days: minutes), far beyond Supabase's 8 s authenticated statement timeout. Resolving the branch
--    set once removes that factor. In exchange every query below states organization_id and the branch filter itself
--    (they are the only barrier), and the tests prove tenant, branch and capability denial as the authenticated role.
-- 3. Supporting indexes so period scans are index-bounded. app.schema_version() moves to this migration.
--
-- Metric definitions (also shown in the UI):
--   operations   bookings by starts_at (period boundaries in the supplied time zone), deleted_at is null,
--                draft excluded. completed / open (requested, confirmed, in_progress) / canceled / no_show.
--   issued       invoices with status <> 'void' by issued_at, per currency.
--   collected    payments with status = 'succeeded' by paid_at, per currency (same predicate as the cash position
--                report and as the invoice paid-flip). pending/failed payments are never counted.
--   refunded     refunds with status = 'succeeded' by refunded_at; currency comes from the refunded payment.
--   outstanding  snapshot "now": invoices with status = 'issued' whose total exceeds their succeeded payments;
--                zero-due invoices (which can never be paid) are never outstanding. overdue = due_at < now().
--   sources      the customer's CURRENT stored source, trimmed, whitespace-collapsed and case-folded; empty = missing.
--                new = non-archived, non-deleted customers by created_at;
--                first completed = customer's earliest completed booking (all history) falls in the period;
--                first paid = customer's earliest succeeded payment on a non-void invoice falls in the period.
begin;

-- ---------------------------------------------------------------------------------------------------------------
-- Card visibility: complete allowlist, legacy-compatible.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.update_dashboard_card_settings(p_cards jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_key text;
  v_legacy constant text[] := array['booking_today','revenue_today','active_customers','open_tasks'];
  v_new constant text[] := array['performance_operations','performance_finance','performance_sources'];
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
  -- Exactly the known keys, every value a boolean.
  for v_key in select jsonb_object_keys(p_cards) loop
    if v_key <> all(v_legacy || v_new) then
      raise exception 'invalid_dashboard_card_key' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array v_legacy loop
    if jsonb_typeof(p_cards -> v_key) is distinct from 'boolean' then
      raise exception 'invalid_dashboard_card_value' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array v_new loop
    if p_cards ? v_key then
      v_supplied := v_supplied + 1;
      if jsonb_typeof(p_cards -> v_key) is distinct from 'boolean' then
        raise exception 'invalid_dashboard_card_value' using errcode = '22023';
      end if;
    end if;
  end loop;
  -- The three new keys arrive together (current form) or not at all (legacy four-key payload).
  if v_supplied not in (0, cardinality(v_new)) then
    raise exception 'invalid_dashboard_card_key' using errcode = '22023';
  end if;

  select settings into v_settings from public.organizations where id = v_org for update;
  if not found then raise exception 'not_authorized' using errcode = '42501'; end if;
  if jsonb_typeof(v_settings) is distinct from 'object' then v_settings := '{}'::jsonb; end if;
  if jsonb_typeof(v_settings -> 'dashboard') = 'object' then
    v_dashboard := v_settings -> 'dashboard';
  else
    v_dashboard := '{}'::jsonb;
  end if;

  v_cards := p_cards;
  if v_supplied = 0 then
    -- Legacy payload: keep whatever boolean the new keys already hold; an absent key stays absent (= visible).
    v_current := case when jsonb_typeof(v_dashboard -> 'cards') = 'object' then v_dashboard -> 'cards' else '{}'::jsonb end;
    foreach v_key in array v_new loop
      if jsonb_typeof(v_current -> v_key) = 'boolean' then
        v_cards := v_cards || jsonb_build_object(v_key, v_current -> v_key);
      end if;
    end loop;
  end if;

  update public.organizations
     set settings = v_settings || jsonb_build_object('dashboard', v_dashboard || jsonb_build_object('cards', v_cards))
   where id = v_org;
end $$;

revoke all on function app.update_dashboard_card_settings(jsonb) from public, anon, authenticated;
grant execute on function app.update_dashboard_card_settings(jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Supporting indexes (period scans, outstanding snapshot).
-- ---------------------------------------------------------------------------------------------------------------
create index if not exists idx_bookings_org_starts_at on public.bookings (organization_id, starts_at) where deleted_at is null;
create index if not exists idx_invoices_org_issued_at on public.invoices (organization_id, issued_at);
create index if not exists idx_invoices_org_open on public.invoices (organization_id) where status = 'issued';
create index if not exists idx_payments_org_paid_at on public.payments (organization_id, paid_at);
create index if not exists idx_refunds_org_refunded_at on public.refunds (organization_id, refunded_at);
create index if not exists idx_customers_org_created_at on public.customers (organization_id, created_at) where deleted_at is null;

-- ---------------------------------------------------------------------------------------------------------------
-- Shared period validation: the application defines the boundaries once; the database refuses inconsistent ones.
-- Both ranges are inclusive local calendar dates; the previous range must be the equal-length range that ends the
-- day before the current one starts. At most 366 days. Pure validation: touches no table other than the catalog.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.dashboard_check_periods(p_from date, p_to date, p_prev_from date, p_prev_to date, p_timezone text default 'Asia/Jakarta')
returns void language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_prev_from is null or p_prev_to is null
     or p_from > p_to or p_prev_from > p_prev_to
     or p_to - p_from > 365                              -- inclusive length <= 366
     or p_prev_to <> p_from - 1                          -- adjacent
     or p_prev_to - p_prev_from <> p_to - p_from         -- equal length
     or p_prev_from < date '2000-01-01' or p_to > date '2100-12-31'
     or p_timezone is null or length(p_timezone) > 64
     or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone) then
    raise exception 'invalid_period' using errcode = '22023';
  end if;
end $$;

revoke all on function app.dashboard_check_periods(date, date, date, date, text) from public, anon, authenticated;
grant execute on function app.dashboard_check_periods(date, date, date, date, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Operations: completed / open / canceled / no-show appointments, current vs previous period.
-- ---------------------------------------------------------------------------------------------------------------
create function app.dashboard_operations_performance(p_from date, p_to date, p_prev_from date, p_prev_to date, p_timezone text default 'Asia/Jakarta')
returns table (period text, completed integer, open_count integer, canceled integer, no_show integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_all boolean;
  v_branches uuid[] := '{}';
  v_cf timestamptz; v_ct timestamptz; v_pf timestamptz;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('booking.read')
     or not app.has_module('scheduling') or app.is_groomer_member() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform app.dashboard_check_periods(p_from, p_to, p_prev_from, p_prev_to, p_timezone);
  v_all := app.has_permission('branches.all');
  if not v_all then
    select coalesce(array_agg(mba.branch_id), '{}') into v_branches
      from public.memberships m
      join public.membership_branch_access mba on mba.organization_id = m.organization_id and mba.membership_id = m.id
     where m.user_id = app.fn_current_user_id() and m.organization_id = v_org and m.status = 'active' and m.deleted_at is null;
  end if;
  v_cf := p_from::timestamp at time zone p_timezone;
  v_ct := (p_to + 1)::timestamp at time zone p_timezone;
  v_pf := p_prev_from::timestamp at time zone p_timezone;

  return query
  with b as (
    select x.status, (x.starts_at >= v_cf) as is_current
      from public.bookings x
     where x.organization_id = v_org and x.deleted_at is null
       and x.starts_at >= v_pf and x.starts_at < v_ct
       and (v_all or x.branch_id = any(v_branches))
  )
  select 'current'::text,
         (count(*) filter (where b.is_current and b.status = 'completed'))::integer,
         (count(*) filter (where b.is_current and b.status in ('requested','confirmed','in_progress')))::integer,
         (count(*) filter (where b.is_current and b.status = 'canceled'))::integer,
         (count(*) filter (where b.is_current and b.status = 'no_show'))::integer
    from b
  union all
  select 'previous'::text,
         (count(*) filter (where not b.is_current and b.status = 'completed'))::integer,
         (count(*) filter (where not b.is_current and b.status in ('requested','confirmed','in_progress')))::integer,
         (count(*) filter (where not b.is_current and b.status = 'canceled'))::integer,
         (count(*) filter (where not b.is_current and b.status = 'no_show'))::integer
    from b;
end $$;

revoke all on function app.dashboard_operations_performance(date, date, date, date, text) from public, anon, authenticated;
grant execute on function app.dashboard_operations_performance(date, date, date, date, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Finance: issued / collected / refunded per currency for both periods, plus the outstanding snapshot.
-- Refunds are reached only through a payment in a visible branch (refunds carry no branch of their own).
-- ---------------------------------------------------------------------------------------------------------------
create function app.dashboard_finance_performance(p_from date, p_to date, p_prev_from date, p_prev_to date, p_timezone text default 'Asia/Jakarta')
returns table (
  period text, currency text,
  issued_total numeric, issued_count integer,
  collected_total numeric, collected_count integer, collected_on_void_count integer,
  refunded_total numeric, refunded_count integer,
  outstanding_total numeric, outstanding_count integer, overdue_count integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_all boolean;
  v_branches uuid[] := '{}';
  v_cf timestamptz; v_ct timestamptz; v_pf timestamptz;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('finance.read')
     or not app.has_module('finance') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform app.dashboard_check_periods(p_from, p_to, p_prev_from, p_prev_to, p_timezone);
  v_all := app.has_permission('branches.all');
  if not v_all then
    select coalesce(array_agg(mba.branch_id), '{}') into v_branches
      from public.memberships m
      join public.membership_branch_access mba on mba.organization_id = m.organization_id and mba.membership_id = m.id
     where m.user_id = app.fn_current_user_id() and m.organization_id = v_org and m.status = 'active' and m.deleted_at is null;
  end if;
  v_cf := p_from::timestamp at time zone p_timezone;
  v_ct := (p_to + 1)::timestamp at time zone p_timezone;
  v_pf := p_prev_from::timestamp at time zone p_timezone;

  return query
  with iss as (
    select (i.issued_at >= v_cf) as is_current, i.currency as cur, coalesce(sum(i.total), 0) as amount, count(*)::integer as n
      from public.invoices i
     where i.organization_id = v_org and i.status <> 'void' and i.issued_at >= v_pf and i.issued_at < v_ct
       and (v_all or i.branch_id = any(v_branches))
     group by 1, 2
  ), col as (
    select (p.paid_at >= v_cf) as is_current, p.currency as cur, coalesce(sum(p.amount), 0) as amount, count(*)::integer as n,
           (count(*) filter (where inv.status = 'void'))::integer as on_void
      from public.payments p
      left join public.invoices inv on inv.organization_id = p.organization_id and inv.id = p.invoice_id
     where p.organization_id = v_org and p.status = 'succeeded' and p.paid_at >= v_pf and p.paid_at < v_ct
       and (v_all or p.branch_id = any(v_branches))
     group by 1, 2
  ), ref as (
    select (r.refunded_at >= v_cf) as is_current, p.currency as cur, coalesce(sum(r.amount), 0) as amount, count(*)::integer as n
      from public.refunds r
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
     where r.organization_id = v_org and r.status = 'succeeded' and r.refunded_at >= v_pf and r.refunded_at < v_ct
       and (v_all or p.branch_id = any(v_branches))
     group by 1, 2
  ), due as (
    select x.currency as cur, coalesce(sum(x.remaining), 0) as amount, count(*)::integer as n,
           (count(*) filter (where x.due_at < now()))::integer as overdue
      from (
        select i.currency, i.due_at,
               i.total - coalesce((select sum(p.amount) from public.payments p
                                    where p.organization_id = v_org and p.invoice_id = i.id and p.status = 'succeeded'), 0) as remaining
          from public.invoices i
         where i.organization_id = v_org and i.status = 'issued' and (v_all or i.branch_id = any(v_branches))
      ) x
     where x.remaining > 0
     group by x.currency
  ), keys as (
    select case when iss.is_current then 'current' else 'previous' end as label, iss.cur from iss
    union select case when col.is_current then 'current' else 'previous' end, col.cur from col
    union select case when ref.is_current then 'current' else 'previous' end, ref.cur from ref
    union select 'snapshot', due.cur from due
  )
  select k.label, k.cur,
         coalesce(iss.amount, 0), coalesce(iss.n, 0),
         coalesce(col.amount, 0), coalesce(col.n, 0), coalesce(col.on_void, 0),
         coalesce(ref.amount, 0), coalesce(ref.n, 0),
         coalesce(due.amount, 0), coalesce(due.n, 0), coalesce(due.overdue, 0)
    from keys k
    left join iss on k.label <> 'snapshot' and iss.cur = k.cur and iss.is_current = (k.label = 'current')
    left join col on k.label <> 'snapshot' and col.cur = k.cur and col.is_current = (k.label = 'current')
    left join ref on k.label <> 'snapshot' and ref.cur = k.cur and ref.is_current = (k.label = 'current')
    left join due on k.label = 'snapshot' and due.cur = k.cur
   order by case k.label when 'current' then 1 when 'previous' then 2 else 3 end, k.cur;
end $$;

revoke all on function app.dashboard_finance_performance(date, date, date, date, text) from public, anon, authenticated;
grant execute on function app.dashboard_finance_performance(date, date, date, date, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Source performance: counts per normalized source bucket. No customer identity, contact data, notes or amounts.
-- Customers carry no branch, so a branch-restricted caller cannot be given a faithful count: branches.all is
-- required (which is also why no branch filter appears below). first_completed / first_paid are NULL (not zero)
-- when the caller lacks booking.read / finance.read. At most ten named sources are returned per period; the rest
-- are folded into one "other" row, and customers without a source stay in their own "missing" row.
-- ---------------------------------------------------------------------------------------------------------------
create function app.dashboard_source_performance(p_from date, p_to date, p_prev_from date, p_prev_to date, p_timezone text default 'Asia/Jakarta')
returns table (
  period text, source_label text, is_missing boolean, is_other boolean, source_count integer,
  new_customers integer, first_completed integer, first_paid integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_can_book boolean;
  v_can_fin boolean;
  v_cf timestamptz; v_ct timestamptz; v_pf timestamptz; v_pt timestamptz;
begin
  if v_org is null or not app.has_membership()
     or not (app.has_permission('customer.read') or app.has_permission('customer.manage'))
     or not app.has_module('crm') or not app.has_permission('branches.all') or app.is_groomer_member() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform app.dashboard_check_periods(p_from, p_to, p_prev_from, p_prev_to, p_timezone);
  v_can_book := app.has_permission('booking.read') and app.has_module('scheduling');
  v_can_fin := app.has_permission('finance.read') and app.has_module('finance');
  v_cf := p_from::timestamp at time zone p_timezone;
  v_ct := (p_to + 1)::timestamp at time zone p_timezone;
  v_pf := p_prev_from::timestamp at time zone p_timezone;
  v_pt := (p_prev_to + 1)::timestamp at time zone p_timezone;

  return query
  with win(label, f, t) as (values ('current', v_cf, v_ct), ('previous', v_pf, v_pt)),
  fc_cand as (
    select b.customer_id, min(b.starts_at) as first_ts
      from public.bookings b
     where v_can_book and b.organization_id = v_org and b.status = 'completed' and b.deleted_at is null
       and b.starts_at >= v_pf and b.starts_at < v_ct
     group by b.customer_id
  ), fc as (
    select fcc.customer_id, fcc.first_ts from fc_cand fcc
     where not exists (select 1 from public.bookings x
                        where x.organization_id = v_org and x.customer_id = fcc.customer_id
                          and x.status = 'completed' and x.deleted_at is null and x.starts_at < fcc.first_ts)
  ), fp_cand as (
    select inv.customer_id, min(p.paid_at) as first_ts
      from public.payments p
      join public.invoices inv on inv.organization_id = p.organization_id and inv.id = p.invoice_id
     where v_can_fin and p.organization_id = v_org and p.status = 'succeeded' and inv.status <> 'void'
       and inv.customer_id is not null and p.paid_at >= v_pf and p.paid_at < v_ct
     group by inv.customer_id
  ), fp as (
    select fpc.customer_id, fpc.first_ts from fp_cand fpc
     where not exists (select 1 from public.invoices yi
                         join public.payments y on y.organization_id = yi.organization_id and y.invoice_id = yi.id
                        where yi.organization_id = v_org and yi.customer_id = fpc.customer_id and yi.status <> 'void'
                          and y.status = 'succeeded' and y.paid_at < fpc.first_ts)
  ), events as (
    -- customer, instant, kind: only customers that produce an event are ever read (no full customer scan)
    select c.id as customer_id, c.created_at as at, 'new'::text as kind
      from public.customers c
     where c.organization_id = v_org and c.created_at >= v_pf and c.created_at < v_ct
    union all select fc.customer_id, fc.first_ts, 'fc' from fc
    union all select fp.customer_id, fp.first_ts, 'fp' from fp
  ), ev as (
    select win.label,
           nullif(lower(regexp_replace(btrim(c.source), '\s+', ' ', 'g')), '') as skey,
           left(nullif(regexp_replace(btrim(c.source), '\s+', ' ', 'g'), ''), 80) as sraw,
           (e.kind = 'new')::integer as nw, (e.kind = 'fc')::integer as cm, (e.kind = 'fp')::integer as pd
      from events e
      join win on e.at >= win.f and e.at < win.t
      join public.customers c on c.organization_id = v_org and c.id = e.customer_id
     where c.deleted_at is null and c.status <> 'archived'
  ), agg as (
    select ev.label, ev.skey, sum(ev.nw)::integer as nw, sum(ev.cm)::integer as cm, sum(ev.pd)::integer as pd
      from ev group by ev.label, ev.skey
  ), names as (
    select ev.skey, min(ev.sraw) as sraw from ev where ev.skey is not null group by ev.skey
  ), ranked as (
    select a.skey, row_number() over (order by sum(a.nw + a.cm + a.pd) desc, a.skey) as rnk
      from agg a where a.skey is not null group by a.skey
  ), tagged as (
    select a.label, a.skey, a.nw, a.cm, a.pd,
           case when a.skey is null then 'missing' when r.rnk <= 10 then 'named' else 'other' end as kind
      from agg a left join ranked r on r.skey = a.skey
  )
  select t.label,
         case when t.kind = 'named' then n.sraw end,
         t.kind = 'missing',
         t.kind = 'other',
         case when t.kind = 'other' then (select count(distinct t2.skey) from tagged t2 where t2.kind = 'other' and t2.label = t.label)::integer else 1 end,
         sum(t.nw)::integer,
         case when v_can_book then sum(t.cm)::integer end,
         case when v_can_fin then sum(t.pd)::integer end
    from tagged t left join names n on n.skey = t.skey
   group by t.label, t.kind, case when t.kind = 'named' then t.skey end, case when t.kind = 'named' then n.sraw end
   order by case t.label when 'current' then 1 else 2 end,
            case t.kind when 'named' then 1 when 'other' then 2 else 3 end,
            sum(t.nw + t.cm + t.pd) desc, 2;
end $$;

revoke all on function app.dashboard_source_performance(date, date, date, date, text) from public, anon, authenticated;
grant execute on function app.dashboard_source_performance(date, date, date, date, text) to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261030100000'::text;
$$;

notify pgrst, 'reload schema';
commit;
