-- E2.2 Read-only cash position by period and currency (parity #31).
--
-- A reporting query over the authoritative payment, refund and expense rows. It creates no ledger,
-- writes nothing, and runs as SECURITY INVOKER so the existing row-level security (organization,
-- branch isolation on payments/expenses, finance.read, module gate) decides which rows are visible.
-- Refunds are joined through their payment, so a refund is only visible when its payment is too
-- (refunds carry no branch of their own). The explicit finance.read check exists so a restricted
-- user gets an error instead of an RLS-emptied zero that looks like "no money moved".
--
-- Never mixes currencies: one row per (calendar month in the given time zone, currency).
-- Counted:  payments with status 'succeeded' by paid_at; refunds with status 'succeeded' by refunded_at;
--           expenses (not soft-deleted) by incurred_at. Pending and failed payments are only counted
--           (excluded_payments), never summed.
-- Not counted: opening balance, capital, transfers between accounts, tax, payroll payouts.
begin;

create function app.finance_cash_position(p_from date, p_to date, p_timezone text default 'Asia/Jakarta')
returns table (
  period text,
  currency text,
  payments_in numeric,
  payments_count integer,
  refunds_out numeric,
  refunds_count integer,
  expenses_out numeric,
  expenses_count integer,
  net numeric,
  excluded_payments integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_org uuid := app.fn_active_organization();
  v_from_ts timestamptz;
  v_to_ts timestamptz;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('finance.read') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366
     or p_from < date '2000-01-01' or p_to > date '2100-12-31'
     or p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone) then
    raise exception 'invalid_period' using errcode = '22023';
  end if;
  v_from_ts := p_from::timestamp at time zone p_timezone;
  v_to_ts := (p_to + 1)::timestamp at time zone p_timezone;

  return query
  with pay as (
    select to_char(p.paid_at at time zone p_timezone, 'YYYY-MM') as period, p.currency,
           coalesce(sum(p.amount) filter (where p.status = 'succeeded'), 0) as amount,
           (count(*) filter (where p.status = 'succeeded'))::integer as n,
           (count(*) filter (where p.status <> 'succeeded'))::integer as excluded
      from public.payments p
     where p.organization_id = v_org and p.paid_at >= v_from_ts and p.paid_at < v_to_ts
     group by 1, 2
  ), ref as (
    select to_char(r.refunded_at at time zone p_timezone, 'YYYY-MM') as period, p.currency,
           coalesce(sum(r.amount), 0) as amount, count(*)::integer as n
      from public.refunds r
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
     where r.organization_id = v_org and r.status = 'succeeded'
       and r.refunded_at >= v_from_ts and r.refunded_at < v_to_ts
     group by 1, 2
  ), exp as (
    select to_char(e.incurred_at, 'YYYY-MM') as period, e.currency,
           coalesce(sum(e.amount), 0) as amount, count(*)::integer as n
      from public.expenses e
     where e.organization_id = v_org and e.deleted_at is null
       and e.incurred_at >= p_from and e.incurred_at <= p_to
     group by 1, 2
  ), keys as (
    select pay.period, pay.currency from pay
    union select ref.period, ref.currency from ref
    union select exp.period, exp.currency from exp
  )
  select k.period, k.currency,
         coalesce(pay.amount, 0), coalesce(pay.n, 0),
         coalesce(ref.amount, 0), coalesce(ref.n, 0),
         coalesce(exp.amount, 0), coalesce(exp.n, 0),
         coalesce(pay.amount, 0) - coalesce(ref.amount, 0) - coalesce(exp.amount, 0),
         coalesce(pay.excluded, 0)
    from keys k
    left join pay on pay.period = k.period and pay.currency = k.currency
    left join ref on ref.period = k.period and ref.currency = k.currency
    left join exp on exp.period = k.period and exp.currency = k.currency
   order by k.period desc, k.currency;
end;
$$;

revoke all on function app.finance_cash_position(date, date, text) from public, anon, authenticated;
grant execute on function app.finance_cash_position(date, date, text) to authenticated;

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
