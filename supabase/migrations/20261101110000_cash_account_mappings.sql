-- Stream 2: explicit cash-account mappings and a mapped cash-on-hand position (parity #31).
--
-- The cash-control register (20261031110000) holds only what a person declares. This migration lets the owner state, once and
-- on the record, WHERE Operro's own authoritative flows land, and then reads the position those mappings imply.
--
-- Mapping (public.cash_account_mappings, insert-only, never updated or deleted):
--   "from <effective_from>, payments by <method> at <branch or every branch> are received into <account>",
--   "... expenses at <branch or every branch> are paid from <account>", "... payroll paid at <branch or every branch> is paid from <account>".
--   An account_id of null stops a mapping from that date. A later row supersedes an earlier one for the same key; the earlier
--   row stays as history. A branch-specific row wins over an organization-wide row. Rows for one key must be dated in
--   non-decreasing order, so history cannot be rewritten by inserting an older date after a newer one.
--
-- Position (app.cash_on_hand): per visible account and in the account's own currency,
--   declared movements through the date  (opening balance, capital, withdrawals, other cash in/out: the register)
--   + succeeded payments mapped to the account
--   - succeeded refunds of such payments (they follow the payment's method and branch)
--   - expenses mapped to the account (the same rows and dates as the read-only cash position report: not deleted, by incurred_at)
--   - payroll paid (financial_ledger 'payroll_paid' entries, which already carry compensating entries for reversed runs)
--   where each flow counts only on or after the effective date of the mapping that applies to it. Nothing before the cutover is
--   counted, so the owner declares the opening balance at the cutover date and nothing is counted twice.
--   A flow that a person already linked to a live (unreversed) register movement is NOT counted again: the declared posting wins.
--   A flow in another currency than its account, a flow with no mapping, and a flow already declared are reported by
--   app.cash_unmapped_flows, so the position never silently leaves something out.
--
-- WHAT THIS IS NOT: a double-entry ledger, a bank reconciliation, profit or accounting. The balance is only as truthful as the
-- mappings and the declared opening balance; nothing is compared with a bank statement.
--
-- Authority: the organization comes only from the session. Mapping needs finance.manage + finance module; organization-wide
-- mappings and organization-wide accounts need branches.all; an account tied to one branch only receives flows of that branch.
-- Reading needs finance.read. A caller who cannot see every branch gets no mapped total for an organization-wide account, because
-- the total would silently omit the branches they cannot see.
begin;

create table public.cash_account_mappings (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow text not null check (flow in ('payment','expense','payroll')),
  method text check (method in ('cash','card','wallet','bank_transfer','other')),
  branch_id uuid,
  account_id uuid,
  effective_from date not null check (effective_from between date '2000-01-01' and date '2100-12-31'),
  request_key uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint uq_cash_account_mappings_org_id unique (organization_id, id),
  constraint uq_cash_account_mappings_request unique (organization_id, request_key),
  constraint fk_cash_account_mappings_branch foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint fk_cash_account_mappings_account foreign key (organization_id, account_id) references public.cash_accounts (organization_id, id),
  constraint chk_cash_account_mappings_method check ((flow = 'payment') = (method is not null))
);
create index idx_cash_account_mappings_key on public.cash_account_mappings (organization_id, flow, method, branch_id, effective_from desc, created_at desc);

create function app.tg_cash_account_mappings_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'cash account mappings are immutable; add a newer mapping instead' using errcode = 'restrict_violation'; end $$;
create trigger trg_cash_account_mappings_immutable before update or delete on public.cash_account_mappings
  for each row execute function app.tg_cash_account_mappings_immutable();
create trigger trg_cash_account_mappings_audit after insert on public.cash_account_mappings
  for each row execute function app.tg_write_audit();

alter table public.cash_account_mappings enable row level security;
revoke all on public.cash_account_mappings from public, anon, authenticated;
grant select on public.cash_account_mappings to authenticated;
create policy cash_account_mappings_read on public.cash_account_mappings for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()
         and app.has_module('finance') and app.has_permission('finance.read')
         and (branch_id is null or app.has_branch(branch_id))));

-- ---------------------------------------------------------------------------------------------------------------
-- Writer
-- ---------------------------------------------------------------------------------------------------------------
create function app.set_cash_account_mapping(
  p_flow text, p_method text, p_branch uuid, p_account uuid, p_effective_from date, p_request_key uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_method text := nullif(btrim(coalesce(p_method, '')), '');
  v_account public.cash_accounts;
  v_existing public.cash_account_mappings;
  v_latest date;
  v_id uuid;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.manage') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_request_key is null or p_flow not in ('payment','expense','payroll')
     or (p_flow = 'payment') <> (v_method is not null)
     or (v_method is not null and v_method not in ('cash','card','wallet','bank_transfer','other'))
     or p_effective_from is null or p_effective_from < date '2000-01-01' or p_effective_from > current_date + 1 then
    raise exception 'invalid_mapping' using errcode = '22023'; end if;

  if p_branch is null then
    if not app.has_permission('branches.all') then raise exception 'not_authorized' using errcode = '42501'; end if;
  else
    perform 1 from public.branches b where b.organization_id = v_org and b.id = p_branch and b.deleted_at is null;
    if not found then raise exception 'branch_not_found' using errcode = 'P0002'; end if;
    if not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode = '42501'; end if;
  end if;

  if p_account is not null then
    select a.* into v_account from public.cash_accounts a where a.organization_id = v_org and a.id = p_account;
    if not found then raise exception 'account_not_found' using errcode = 'P0002'; end if;
    if v_account.status <> 'active' then raise exception 'account_archived' using errcode = '22023'; end if;
    -- An account tied to one branch only receives that branch's flows; an organization-wide rule only feeds an organization-wide account.
    if v_account.branch_id is not null and p_branch is distinct from v_account.branch_id then
      raise exception 'account_branch_mismatch' using errcode = '22023'; end if;
    if p_branch is null and v_account.branch_id is not null then
      raise exception 'account_branch_mismatch' using errcode = '22023'; end if;
    if v_account.branch_id is null and not app.has_permission('branches.all') then
      raise exception 'not_authorized' using errcode = '42501'; end if;
  end if;

  select m.* into v_existing from public.cash_account_mappings m where m.organization_id = v_org and m.request_key = p_request_key;
  if found then
    if v_existing.flow = p_flow and v_existing.method is not distinct from v_method and v_existing.branch_id is not distinct from p_branch
       and v_existing.account_id is not distinct from p_account and v_existing.effective_from = p_effective_from then
      return v_existing.id; end if;
    raise exception 'request_conflict' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cash_mapping:' || v_org::text, 0));
  if (select count(*) from public.cash_account_mappings m where m.organization_id = v_org) >= 500 then
    raise exception 'mapping_limit_reached' using errcode = '22023'; end if;
  select max(m.effective_from) into v_latest from public.cash_account_mappings m
   where m.organization_id = v_org and m.flow = p_flow and m.method is not distinct from v_method and m.branch_id is not distinct from p_branch;
  if v_latest is not null and p_effective_from < v_latest then
    raise exception 'effective_from_not_after_previous' using errcode = '22023'; end if;

  insert into public.cash_account_mappings(organization_id, flow, method, branch_id, account_id, effective_from, request_key, created_by)
  values (v_org, p_flow, v_method, p_branch, p_account, p_effective_from, p_request_key, app.fn_current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Flow resolution shared by the position and the unmapped report. Both call it with the same arguments so they cannot disagree.
-- One row per authoritative flow on or after the earliest mapping date: what it is, when, where, how much, and which account (if
-- any) the applicable mapping sends it to.
-- ---------------------------------------------------------------------------------------------------------------
create function app.cash_flow_resolution(p_as_of date, p_timezone text)
returns table (
  kind text, source_id uuid, flow_date date, branch_id uuid, currency text, amount numeric,
  mapped_account uuid, account_currency text, already_declared boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_all boolean;
  v_branches uuid[] := '{}';
  v_min date;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.read') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_as_of is null or p_as_of < date '2000-01-01' or p_as_of > date '2100-12-31'
     or p_timezone is null or length(p_timezone) > 64
     or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone) then
    raise exception 'invalid_period' using errcode = '22023'; end if;
  v_all := app.has_permission('branches.all');
  if not v_all then
    select coalesce(array_agg(mba.branch_id), '{}') into v_branches
      from public.memberships m
      join public.membership_branch_access mba on mba.organization_id = m.organization_id and mba.membership_id = m.id
     where m.user_id = app.fn_current_user_id() and m.organization_id = v_org and m.status = 'active' and m.deleted_at is null;
  end if;
  select min(mp.effective_from) into v_min from public.cash_account_mappings mp where mp.organization_id = v_org;
  if v_min is null or v_min > p_as_of then return; end if;

  return query
  with live_links as (
    select m.source_type as stype, m.source_id as sid
      from public.cash_movements m
     where m.organization_id = v_org and m.source_id is not null and m.kind <> 'reversal'
       and not exists (select 1 from public.cash_movements r where r.organization_id = v_org and r.reversal_of = m.id)
  ), flows as (
    select 'payment'::text as k, p.id as sid, (p.paid_at at time zone p_timezone)::date as d, p.branch_id as b, p.currency as c, p.amount as amt, 'payment'::text as mflow, p.method as mmethod
      from public.payments p
     where p.organization_id = v_org and p.status = 'succeeded'
       and p.paid_at >= (v_min::timestamp at time zone p_timezone) and p.paid_at < ((p_as_of + 1)::timestamp at time zone p_timezone)
    union all
    select 'refund', r.id, (r.refunded_at at time zone p_timezone)::date, p.branch_id, p.currency, r.amount, 'payment', p.method
      from public.refunds r
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
     where r.organization_id = v_org and r.status = 'succeeded'
       and r.refunded_at >= (v_min::timestamp at time zone p_timezone) and r.refunded_at < ((p_as_of + 1)::timestamp at time zone p_timezone)
    union all
    select 'expense', e.id, e.incurred_at, e.branch_id, e.currency, e.amount, 'expense', null::text
      from public.expenses e
     where e.organization_id = v_org and e.deleted_at is null and e.incurred_at >= v_min and e.incurred_at <= p_as_of
    union all
    select 'payroll', l.id, (l.occurred_at at time zone p_timezone)::date, l.branch_id, l.currency, -l.amount, 'payroll', null::text
      from public.financial_ledger l
     where l.organization_id = v_org and l.entry_type = 'payroll_paid'
       and l.occurred_at >= (v_min::timestamp at time zone p_timezone) and l.occurred_at < ((p_as_of + 1)::timestamp at time zone p_timezone)
  )
  select f.k, f.sid, f.d, f.b, f.c, f.amt, m.account_id, a.currency,
         exists (select 1 from live_links ll where ll.sid = f.sid and ll.stype = f.k)
    from flows f
    left join lateral (
      select mp.account_id
        from public.cash_account_mappings mp
       where mp.organization_id = v_org and mp.flow = f.mflow and mp.method is not distinct from f.mmethod
         and (mp.branch_id = f.b or mp.branch_id is null) and mp.effective_from <= f.d
       order by (mp.branch_id is not null) desc, mp.effective_from desc, mp.created_at desc, mp.id desc
       limit 1
    ) m on true
    left join public.cash_accounts a on a.organization_id = v_org and a.id = m.account_id
   where v_all or (f.b is not null and f.b = any(v_branches));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Position per visible account
-- ---------------------------------------------------------------------------------------------------------------
create function app.cash_on_hand(p_as_of date default null, p_timezone text default 'Asia/Jakarta')
returns table (
  account_id uuid, account_name text, kind text, currency text, branch_id uuid, status text,
  declared_balance numeric, payments_in numeric, refunds_out numeric, expenses_out numeric, payroll_out numeric,
  balance numeric, mapped_complete boolean, mapped_flows integer, first_effective date)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_all boolean;
  v_branches uuid[] := '{}';
  v_asof date;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.read') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_timezone is null or length(p_timezone) > 64 or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone) then
    raise exception 'invalid_period' using errcode = '22023'; end if;
  v_asof := coalesce(p_as_of, (now() at time zone p_timezone)::date);
  if v_asof < date '2000-01-01' or v_asof > date '2100-12-31' then raise exception 'invalid_period' using errcode = '22023'; end if;
  v_all := app.has_permission('branches.all');
  if not v_all then
    select coalesce(array_agg(mba.branch_id), '{}') into v_branches
      from public.memberships m
      join public.membership_branch_access mba on mba.organization_id = m.organization_id and mba.membership_id = m.id
     where m.user_id = app.fn_current_user_id() and m.organization_id = v_org and m.status = 'active' and m.deleted_at is null;
  end if;

  return query
  with acc as (
    select a.* from public.cash_accounts a
     where a.organization_id = v_org and (a.branch_id is null or v_all or a.branch_id = any(v_branches))
  ), decl as (
    select m.account_id as aid, sum(case m.direction when 'in' then m.amount else -m.amount end) as bal
      from public.cash_movements m
     where m.organization_id = v_org and m.occurred_on <= v_asof
     group by m.account_id
  ), res as (
    select r.* from app.cash_flow_resolution(v_asof, p_timezone) r
     where r.mapped_account is not null and r.currency = r.account_currency and not r.already_declared
  ), agg as (
    select r.mapped_account as aid,
           coalesce(sum(r.amount) filter (where r.kind = 'payment'), 0) as pin,
           coalesce(sum(r.amount) filter (where r.kind = 'refund'), 0) as rout,
           coalesce(sum(r.amount) filter (where r.kind = 'expense'), 0) as eout,
           coalesce(sum(r.amount) filter (where r.kind = 'payroll'), 0) as pout,
           count(*)::integer as n
      from res r group by r.mapped_account
  ), eff as (
    select mp.account_id as aid, min(mp.effective_from) as first_eff
      from public.cash_account_mappings mp where mp.organization_id = v_org and mp.account_id is not null group by mp.account_id
  )
  select a.id, a.name, a.kind, a.currency, a.branch_id, a.status,
         coalesce(d.bal, 0),
         case when a.branch_id is not null or v_all then coalesce(g.pin, 0) end,
         case when a.branch_id is not null or v_all then coalesce(g.rout, 0) end,
         case when a.branch_id is not null or v_all then coalesce(g.eout, 0) end,
         case when a.branch_id is not null or v_all then coalesce(g.pout, 0) end,
         case when a.branch_id is not null or v_all then coalesce(d.bal, 0) + coalesce(g.pin, 0) - coalesce(g.rout, 0) - coalesce(g.eout, 0) - coalesce(g.pout, 0) end,
         (a.branch_id is not null or v_all),
         case when a.branch_id is not null or v_all then coalesce(g.n, 0) end,
         e.first_eff
    from acc a
    left join decl d on d.aid = a.id
    left join agg g on g.aid = a.id
    left join eff e on e.aid = a.id
   order by a.status, a.currency, a.name;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- What the position leaves out, by kind, currency and reason.
-- ---------------------------------------------------------------------------------------------------------------
create function app.cash_unmapped_flows(p_as_of date default null, p_timezone text default 'Asia/Jakarta')
returns table (kind text, currency text, reason text, flow_count integer, total_amount numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_asof date;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.read') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_timezone is null or length(p_timezone) > 64 or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone) then
    raise exception 'invalid_period' using errcode = '22023'; end if;
  v_asof := coalesce(p_as_of, (now() at time zone p_timezone)::date);
  if v_asof < date '2000-01-01' or v_asof > date '2100-12-31' then raise exception 'invalid_period' using errcode = '22023'; end if;
  return query
  select r.kind, r.currency,
         case when r.already_declared then 'already_declared'
              when r.mapped_account is null then 'not_mapped'
              else 'currency_mismatch' end,
         count(*)::integer, sum(abs(r.amount))
    from app.cash_flow_resolution(v_asof, p_timezone) r
   where r.already_declared or r.mapped_account is null or r.currency <> r.account_currency
   group by 1, 2, 3
   order by 1, 2, 3;
end $$;

revoke all on function app.tg_cash_account_mappings_immutable() from public, anon, authenticated;
revoke all on function app.set_cash_account_mapping(text, text, uuid, uuid, date, uuid) from public, anon, authenticated;
revoke all on function app.cash_flow_resolution(date, text) from public, anon, authenticated;
revoke all on function app.cash_on_hand(date, text) from public, anon, authenticated;
revoke all on function app.cash_unmapped_flows(date, text) from public, anon, authenticated;
grant execute on function app.set_cash_account_mapping(text, text, uuid, uuid, date, uuid) to authenticated;
grant execute on function app.cash_on_hand(date, text) to authenticated;
grant execute on function app.cash_unmapped_flows(date, text) to authenticated;
-- cash_flow_resolution is an internal helper of the two readers; clients never call it directly.

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101110000'::text;
$$;

notify pgrst, 'reload schema';
commit;
