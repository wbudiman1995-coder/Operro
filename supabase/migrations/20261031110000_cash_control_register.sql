-- P2: cash-control register (parity #31, HomePaw "Modal" / "Kas tersedia").
--
-- WHAT THIS IS: a tenant-scoped register of cash / bank / e-wallet accounts and IMMUTABLE movements that a person
-- declares (opening balance, capital contribution, owner withdrawal, other cash in/out). Each movement belongs to one
-- account, one currency and one calendar day; it may be linked to the existing expense / payment / refund it relates
-- to. Mistakes are corrected only by a reversal entry; rows are never updated or deleted (a trigger refuses it even
-- for the table owner). The position is the sum of the account's own movements, per account and per currency.
--
-- WHAT THIS IS NOT: a double-entry ledger, a bank reconciliation, profit, tax or accounting. Payments, refunds,
-- expenses and payroll payouts do NOT move these balances automatically, and no payment is mapped to an account:
-- a link is a reference, not a posting. The existing read-only cash position report (app.finance_cash_position)
-- remains the view of recorded payments, refunds and expenses; the two are shown side by side and never netted.
-- Truthful "cash on hand" (HomePaw: capital - expenses - salaries paid) would need an owner decision on payment ->
-- account mapping, payroll payout recording and reconciliation to bank statements; that decision is documented in
-- docs/handoffs/CLAUDE-FINAL-PARITY-CLOSEOUT-HANDOFF.md and is NOT taken here.
--
-- Authority: the organization comes only from the session. Reading needs finance.read (+ finance module) and the
-- account's branch; writing needs finance.manage (the owner holds it by default; owners may grant it to Admin), and
-- an organization-wide account (no branch) can only be created or posted to by a caller with branches.all.
-- Clients get SELECT only; every write is an RPC. Every row change lands in app.audit_log (existing trigger).
begin;

create table public.cash_accounts (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  name text not null check (name = btrim(name) and length(name) between 1 and 80 and name !~ '[\x00-\x1f]'),
  kind text not null check (kind in ('cash','bank','ewallet','other')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active','archived')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint uq_cash_accounts_org_id unique (organization_id, id),
  constraint fk_cash_accounts_branch foreign key (organization_id, branch_id) references public.branches (organization_id, id)
);
create unique index uq_cash_accounts_name on public.cash_accounts (organization_id, lower(name));
create index idx_cash_accounts_org_status on public.cash_accounts (organization_id, status);

create table public.cash_movements (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid not null,
  branch_id uuid,
  kind text not null check (kind in ('opening_balance','capital_contribution','owner_withdrawal','cash_in','cash_out','reversal')),
  direction text not null check (direction in ('in','out')),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_on date not null check (occurred_on between date '2000-01-01' and date '2100-12-31'),
  counterparty text check (counterparty is null or (counterparty = btrim(counterparty) and length(counterparty) between 1 and 80 and counterparty !~ '[\x00-\x1f]')),
  memo text check (memo is null or (length(memo) between 1 and 300 and memo !~ '[\x00-\x08\x0b\x0c\x0e-\x1f]')),
  source_type text check (source_type in ('expense','payment','refund')),
  source_id uuid,
  reversal_of uuid,
  request_key uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint uq_cash_movements_org_id unique (organization_id, id),
  constraint uq_cash_movements_request unique (organization_id, request_key),
  constraint fk_cash_movements_account foreign key (organization_id, account_id) references public.cash_accounts (organization_id, id),
  constraint fk_cash_movements_reversal foreign key (organization_id, reversal_of) references public.cash_movements (organization_id, id),
  constraint chk_cash_movements_source check ((source_type is null) = (source_id is null)),
  constraint chk_cash_movements_direction check (
    (kind in ('opening_balance','capital_contribution','cash_in') and direction = 'in')
    or (kind in ('owner_withdrawal','cash_out') and direction = 'out')
    or kind = 'reversal'),
  constraint chk_cash_movements_reversal check ((kind = 'reversal') = (reversal_of is not null)),
  constraint chk_cash_movements_counterparty check (kind not in ('capital_contribution','owner_withdrawal') or counterparty is not null),
  constraint chk_cash_movements_reversal_memo check (kind <> 'reversal' or memo is not null)
);
-- A movement can be reversed once.
create unique index uq_cash_movements_reversal_of on public.cash_movements (organization_id, reversal_of) where reversal_of is not null;
create index idx_cash_movements_account on public.cash_movements (organization_id, account_id, occurred_on desc, id desc);
create index idx_cash_movements_source on public.cash_movements (organization_id, source_type, source_id) where source_id is not null;

create function app.tg_cash_movements_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'cash movements are immutable; record a reversal instead' using errcode = 'restrict_violation'; end $$;
create trigger trg_cash_movements_immutable before update or delete on public.cash_movements
  for each row execute function app.tg_cash_movements_immutable();
create trigger trg_cash_accounts_updated_at before update on public.cash_accounts
  for each row execute function app.tg_set_updated_at();
create trigger trg_cash_accounts_audit after insert or update or delete on public.cash_accounts
  for each row execute function app.tg_write_audit();
create trigger trg_cash_movements_audit after insert on public.cash_movements
  for each row execute function app.tg_write_audit();

alter table public.cash_accounts enable row level security;
alter table public.cash_movements enable row level security;
revoke all on public.cash_accounts, public.cash_movements from public, anon, authenticated;
grant select on public.cash_accounts, public.cash_movements to authenticated;

create policy cash_accounts_read on public.cash_accounts for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()
         and app.has_module('finance') and app.has_permission('finance.read')
         and (branch_id is null or app.has_branch(branch_id))));
create policy cash_movements_read on public.cash_movements for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()
         and app.has_module('finance') and app.has_permission('finance.read')
         and (branch_id is null or app.has_branch(branch_id))));

-- ---------------------------------------------------------------------------------------------------------------
-- Writers.  All: definer, empty search_path, session organization, finance.manage + finance module.
-- ---------------------------------------------------------------------------------------------------------------
create function app.create_cash_account(p_name text, p_kind text, p_currency text, p_branch uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_name text := btrim(coalesce(p_name, ''));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_id uuid;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.manage') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if length(v_name) not between 1 and 80 or v_name ~ '[\x00-\x1f]' or p_kind not in ('cash','bank','ewallet','other')
     or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid_account' using errcode = '22023'; end if;
  if p_branch is null then
    if not app.has_permission('branches.all') then raise exception 'not_authorized' using errcode = '42501'; end if;
  else
    perform 1 from public.branches b where b.organization_id = v_org and b.id = p_branch and b.deleted_at is null;
    if not found then raise exception 'branch_not_found' using errcode = 'P0002'; end if;
    if not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode = '42501'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cash_account:' || v_org::text, 0));
  if (select count(*) from public.cash_accounts a where a.organization_id = v_org and a.status = 'active') >= 20 then
    raise exception 'account_limit_reached' using errcode = '22023'; end if;
  if exists (select 1 from public.cash_accounts a where a.organization_id = v_org and lower(a.name) = lower(v_name)) then
    raise exception 'duplicate_account_name' using errcode = '23505'; end if;
  insert into public.cash_accounts(organization_id, branch_id, name, kind, currency, created_by, updated_by)
  values (v_org, p_branch, v_name, p_kind, v_currency, app.fn_current_user_id(), app.fn_current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- Posting rules shared by record/reverse are inline; the account row is locked so balance checks and the
-- "one live opening balance / one live source link" rules cannot race.
create function app.record_cash_movement(
  p_account uuid, p_kind text, p_amount numeric, p_occurred_on date, p_counterparty text, p_memo text,
  p_source_type text, p_source_id uuid, p_request_key uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_account public.cash_accounts;
  v_existing public.cash_movements;
  v_direction text;
  v_counterparty text := nullif(btrim(coalesce(p_counterparty, '')), '');
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_source_ccy text;
  v_id uuid;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.manage') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_account is null or p_request_key is null or p_kind not in ('opening_balance','capital_contribution','owner_withdrawal','cash_in','cash_out')
     or p_amount is null or p_amount <= 0 or p_amount >= 1000000000000 or p_amount <> round(p_amount, 2)
     or p_occurred_on is null or p_occurred_on < date '2000-01-01' or p_occurred_on > current_date + 1
     or (v_counterparty is not null and (length(v_counterparty) > 80 or v_counterparty ~ '[\x00-\x1f]'))
     or (v_memo is not null and (length(v_memo) > 300 or v_memo ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]'))
     or (p_kind in ('capital_contribution','owner_withdrawal') and v_counterparty is null)
     or ((p_source_type is null) <> (p_source_id is null))
     or (p_source_type is not null and (p_source_type not in ('expense','payment','refund')
          or (p_kind = 'cash_in' and p_source_type <> 'payment')
          or (p_kind = 'cash_out' and p_source_type not in ('expense','refund'))
          or p_kind not in ('cash_in','cash_out'))) then
    raise exception 'invalid_movement' using errcode = '22023'; end if;
  v_direction := case when p_kind in ('opening_balance','capital_contribution','cash_in') then 'in' else 'out' end;

  select a.* into v_account from public.cash_accounts a where a.organization_id = v_org and a.id = p_account for update;
  if not found then raise exception 'account_not_found' using errcode = 'P0002'; end if;
  if v_account.branch_id is null then
    if not app.has_permission('branches.all') then raise exception 'not_authorized' using errcode = '42501'; end if;
  elsif not app.has_branch(v_account.branch_id) then
    raise exception 'account_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent replay of the same request; a different payload under the same key is a conflict.
  select m.* into v_existing from public.cash_movements m where m.organization_id = v_org and m.request_key = p_request_key;
  if found then
    if v_existing.account_id = p_account and v_existing.kind = p_kind and v_existing.amount = p_amount and v_existing.occurred_on = p_occurred_on then
      return v_existing.id; end if;
    raise exception 'request_conflict' using errcode = '22023';
  end if;

  if v_account.status <> 'active' then raise exception 'account_archived' using errcode = '22023'; end if;
  if p_kind = 'opening_balance' and exists (
       select 1 from public.cash_movements m
        where m.organization_id = v_org and m.account_id = p_account and m.kind = 'opening_balance'
          and not exists (select 1 from public.cash_movements r where r.organization_id = v_org and r.reversal_of = m.id)) then
    raise exception 'opening_balance_exists' using errcode = '22023'; end if;

  if p_source_type is not null then
    if p_source_type = 'expense' then
      select e.currency into v_source_ccy from public.expenses e
       where e.organization_id = v_org and e.id = p_source_id and e.deleted_at is null
         and (e.branch_id is null or app.has_branch(e.branch_id));
    elsif p_source_type = 'payment' then
      select p.currency into v_source_ccy from public.payments p
       where p.organization_id = v_org and p.id = p_source_id and p.status = 'succeeded'
         and (p.branch_id is null or app.has_branch(p.branch_id));
    else
      select pay.currency into v_source_ccy from public.refunds r
        join public.payments pay on pay.organization_id = r.organization_id and pay.id = r.payment_id
       where r.organization_id = v_org and r.id = p_source_id and r.status = 'succeeded'
         and (pay.branch_id is null or app.has_branch(pay.branch_id));
    end if;
    if not found then raise exception 'source_not_found' using errcode = 'P0002'; end if;
    if v_source_ccy is distinct from v_account.currency then raise exception 'currency_mismatch' using errcode = '22023'; end if;
    if exists (
         select 1 from public.cash_movements m
          where m.organization_id = v_org and m.account_id = p_account and m.source_type = p_source_type and m.source_id = p_source_id
            and m.kind <> 'reversal'
            and not exists (select 1 from public.cash_movements r where r.organization_id = v_org and r.reversal_of = m.id)) then
      raise exception 'source_already_linked' using errcode = '22023'; end if;
  end if;

  insert into public.cash_movements(organization_id, account_id, branch_id, kind, direction, amount, currency, occurred_on,
                                    counterparty, memo, source_type, source_id, request_key, created_by)
  values (v_org, p_account, v_account.branch_id, p_kind, v_direction, p_amount, v_account.currency, p_occurred_on,
          v_counterparty, v_memo, p_source_type, p_source_id, p_request_key, app.fn_current_user_id())
  returning id into v_id;
  return v_id;
end $$;

create function app.reverse_cash_movement(p_movement uuid, p_reason text, p_occurred_on date, p_request_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_orig public.cash_movements;
  v_account public.cash_accounts;
  v_existing public.cash_movements;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id uuid;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.manage') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_movement is null or p_request_key is null or v_reason is null or length(v_reason) not between 3 and 300
     or v_reason ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]'
     or p_occurred_on is null or p_occurred_on < date '2000-01-01' or p_occurred_on > current_date + 1 then
    raise exception 'invalid_reversal' using errcode = '22023'; end if;

  select m.* into v_orig from public.cash_movements m where m.organization_id = v_org and m.id = p_movement;
  if not found then raise exception 'movement_not_found' using errcode = 'P0002'; end if;
  select a.* into v_account from public.cash_accounts a where a.organization_id = v_org and a.id = v_orig.account_id for update;
  if v_account.branch_id is null then
    if not app.has_permission('branches.all') then raise exception 'not_authorized' using errcode = '42501'; end if;
  elsif not app.has_branch(v_account.branch_id) then
    raise exception 'movement_not_found' using errcode = 'P0002';
  end if;

  select m.* into v_existing from public.cash_movements m where m.organization_id = v_org and m.request_key = p_request_key;
  if found then
    if v_existing.reversal_of = p_movement then return v_existing.id; end if;
    raise exception 'request_conflict' using errcode = '22023';
  end if;

  if v_orig.kind = 'reversal' then raise exception 'cannot_reverse_a_reversal' using errcode = '22023'; end if;
  if exists (select 1 from public.cash_movements r where r.organization_id = v_org and r.reversal_of = p_movement) then
    raise exception 'already_reversed' using errcode = '22023'; end if;
  if p_occurred_on < v_orig.occurred_on then raise exception 'invalid_reversal' using errcode = '22023'; end if;

  insert into public.cash_movements(organization_id, account_id, branch_id, kind, direction, amount, currency, occurred_on,
                                    counterparty, memo, source_type, source_id, reversal_of, request_key, created_by)
  values (v_org, v_orig.account_id, v_orig.branch_id, 'reversal', case v_orig.direction when 'in' then 'out' else 'in' end,
          v_orig.amount, v_orig.currency, p_occurred_on, v_orig.counterparty, v_reason, v_orig.source_type, v_orig.source_id,
          v_orig.id, p_request_key, app.fn_current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- Archiving needs a zero balance (so a closing entry is a deliberate act) and the version the caller saw.
create function app.set_cash_account_archived(p_account uuid, p_archived boolean, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_account public.cash_accounts;
  v_balance numeric;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.manage') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_account is null or p_archived is null or p_expected_version is null then raise exception 'invalid_account' using errcode = '22023'; end if;
  select a.* into v_account from public.cash_accounts a where a.organization_id = v_org and a.id = p_account for update;
  if not found then raise exception 'account_not_found' using errcode = 'P0002'; end if;
  if v_account.branch_id is null then
    if not app.has_permission('branches.all') then raise exception 'not_authorized' using errcode = '42501'; end if;
  elsif not app.has_branch(v_account.branch_id) then
    raise exception 'account_not_found' using errcode = 'P0002';
  end if;
  if v_account.version <> p_expected_version then raise exception 'stale_account' using errcode = '40001'; end if;
  if (v_account.status = 'archived') = p_archived then return v_account.version; end if;
  if p_archived then
    select coalesce(sum(case m.direction when 'in' then m.amount else -m.amount end), 0) into v_balance
      from public.cash_movements m where m.organization_id = v_org and m.account_id = p_account;
    if v_balance <> 0 then raise exception 'balance_not_zero' using errcode = '22023'; end if;
  elsif (select count(*) from public.cash_accounts a where a.organization_id = v_org and a.status = 'active') >= 20 then
    raise exception 'account_limit_reached' using errcode = '22023';
  end if;
  update public.cash_accounts
     set status = case when p_archived then 'archived' else 'active' end, version = version + 1, updated_by = app.fn_current_user_id()
   where id = p_account
   returning version into v_account.version;
  return v_account.version;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Position: per visible account, in the account's own currency. Reversals are ordinary opposite entries, so the
-- balance is simply in - out. as_of limits to movements on or before that date (null = all). Definer so the branch
-- set is resolved once; the account's branch rule is the same as the table's policy.
-- ---------------------------------------------------------------------------------------------------------------
create function app.cash_register_position(p_as_of date default null)
returns table (
  account_id uuid, account_name text, kind text, currency text, branch_id uuid, status text, version integer,
  total_in numeric, total_out numeric, balance numeric, movement_count integer, last_movement_on date)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_all boolean;
  v_branches uuid[] := '{}';
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('finance.read') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_as_of is not null and (p_as_of < date '2000-01-01' or p_as_of > date '2100-12-31') then
    raise exception 'invalid_period' using errcode = '22023'; end if;
  v_all := app.has_permission('branches.all');
  if not v_all then
    select coalesce(array_agg(mba.branch_id), '{}') into v_branches
      from public.memberships m
      join public.membership_branch_access mba on mba.organization_id = m.organization_id and mba.membership_id = m.id
     where m.user_id = app.fn_current_user_id() and m.organization_id = v_org and m.status = 'active' and m.deleted_at is null;
  end if;
  return query
  select a.id, a.name, a.kind, a.currency, a.branch_id, a.status, a.version,
         coalesce(sum(m.amount) filter (where m.direction = 'in'), 0),
         coalesce(sum(m.amount) filter (where m.direction = 'out'), 0),
         coalesce(sum(case m.direction when 'in' then m.amount else -m.amount end), 0),
         (count(m.id))::integer,
         max(m.occurred_on)
    from public.cash_accounts a
    left join public.cash_movements m on m.organization_id = a.organization_id and m.account_id = a.id
         and (p_as_of is null or m.occurred_on <= p_as_of)
   where a.organization_id = v_org and (a.branch_id is null or v_all or a.branch_id = any(v_branches))
   group by a.id
   order by (a.status = 'archived'), a.currency, lower(a.name), a.id;
end $$;

revoke all on function app.tg_cash_movements_immutable(), app.create_cash_account(text, text, text, uuid),
  app.record_cash_movement(uuid, text, numeric, date, text, text, text, uuid, uuid),
  app.reverse_cash_movement(uuid, text, date, uuid), app.set_cash_account_archived(uuid, boolean, integer),
  app.cash_register_position(date) from public, anon, authenticated;
grant execute on function app.create_cash_account(text, text, text, uuid),
  app.record_cash_movement(uuid, text, numeric, date, text, text, text, uuid, uuid),
  app.reverse_cash_movement(uuid, text, date, uuid), app.set_cash_account_archived(uuid, boolean, integer),
  app.cash_register_position(date) to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261031110000'::text;
$$;

notify pgrst, 'reload schema';
commit;
