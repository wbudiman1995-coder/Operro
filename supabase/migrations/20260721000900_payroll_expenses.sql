-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0009_payroll_expenses
-- Milestone        6B — Financial Domain (Payroll, Commission, Expenses)
-- Purpose          The cost side of finance, consuming immutable operational
--                  and financial facts (Rule 34): a pure Commission resolver
--                  (Rules 30/33) with an immutable commission ledger; staff
--                  compensation config; Payroll runs/items that freeze on
--                  approval (Rules 31/32); Expenses; and typed extensions to
--                  the financial ledger for payroll/expense payouts.
-- Dependencies     0001, 0002, 0004, 0005 (bookings), 0008 (financial_ledger).
-- Objects Created  app.resolve_commission(...)  -- pure resolver
--                  TABLES commission_rules, commission_entries,
--                  staff_compensation, payroll_runs, payroll_items, expenses
--                  FNS/triggers: accrual, freeze, ledger population
--                  ALTER financial_ledger: + payroll_run_id/expense_id (typed
--                  FKs), widen entry_type check (non-breaking).
-- Constraints      COMPOSITE + TYPED FKs; immutable ledgers; frozen docs.
-- RLS Policies     RLS ENABLED (deny-all). Policies in M8. Module gating
--                  (M8): payroll -> 'payroll'; expenses/commission -> 'finance'.
-- Breaking Changes None. Ledger check-constraint is widened (additive).
-- Rollback         Reverse: drop triggers/fns, revert ledger alter, drop 6
--                  tables + resolver.
-- Notes            Commission DECIDED by a pure resolver, PRESERVED as an
--                  immutable entry that owns its snapshot (Rule 33). Money
--                  rows carry explicit currency (Rule 36). payments.status
--                  already text+chk, so richer lifecycles (Rule 35) extend
--                  without redesign.
-- =====================================================================


-- =====================================================================
-- SECTION 001 — commission_rules (config) + pure resolver + entries
-- =====================================================================
create table public.commission_rules (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  name            text          not null,
  scope           text          not null default 'global',    -- global | service
  service_id      uuid,
  rate_type       text          not null default 'percent',    -- percent | fixed
  rate_value      numeric(14,3)  not null default 0,
  priority        integer       not null default 0,            -- higher wins
  is_active       boolean       not null default true,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_commission_rules primary key (id),
  constraint fk_commission_rules_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_commission_rules_services foreign key (organization_id, service_id) references public.service_catalog (organization_id, id) on delete cascade,
  constraint chk_commission_rules_scope check (scope in ('global','service')),
  constraint chk_commission_rules_rate_type check (rate_type in ('percent','fixed'))
);
create index idx_commission_rules_org on public.commission_rules (organization_id);
create trigger trg_commission_rules_updated_at before update on public.commission_rules for each row execute function app.tg_set_updated_at();
create trigger trg_commission_rules_audit_cols before insert or update on public.commission_rules for each row execute function app.tg_set_audit_columns();
create trigger trg_commission_rules_audit after insert or update or delete on public.commission_rules for each row execute function app.tg_write_audit();

-- Pure, deterministic commission resolver (ADR-002; Rule 30).
create or replace function app.resolve_commission(
  p_org uuid, p_service_id uuid, p_base_amount numeric, p_at timestamptz default now())
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare r record; v_amount numeric(14,2);
begin
  select * into r from public.commission_rules cr
  where cr.organization_id = p_org and cr.is_active
    and (cr.scope = 'global' or (cr.scope = 'service' and cr.service_id = p_service_id))
  order by (cr.scope = 'service') desc, cr.priority desc
  limit 1;
  if r is null then
    return jsonb_build_object('commission_amount', 0, 'source', 'none');
  end if;
  v_amount := case when r.rate_type = 'percent'
                   then round(p_base_amount * r.rate_value / 100.0, 2)
                   else round(r.rate_value, 2) end;
  return jsonb_build_object(
    'rule_id', r.id, 'rate_type', r.rate_type, 'rate_value', r.rate_value,
    'base_amount', p_base_amount, 'commission_amount', v_amount, 'source', r.scope);
end; $$;

-- Immutable commission ledger; each entry owns its snapshot (Rule 33).
create table public.commission_entries (
  id                   uuid          not null default app.fn_uuid_v7(),
  organization_id      uuid          not null,
  membership_id        uuid          not null,                 -- staff who earned it
  reference_booking_id uuid,
  reference_invoice_id uuid,
  base_amount          numeric(14,2)  not null,
  rate_snapshot        jsonb         not null default '{}'::jsonb,
  commission_amount    numeric(14,2)  not null,
  currency             text          not null default 'USD',
  status               text          not null default 'accrued', -- accrued | paid | reversed
  occurred_at          timestamptz   not null default now(),
  created_at           timestamptz   not null default now(),
  created_by           uuid,
  constraint pk_commission_entries primary key (id),
  constraint fk_commission_entries_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_commission_entries_memberships foreign key (organization_id, membership_id) references public.memberships (organization_id, id),
  constraint fk_commission_entries_bookings foreign key (organization_id, reference_booking_id) references public.bookings (organization_id, id),
  constraint fk_commission_entries_invoices foreign key (organization_id, reference_invoice_id) references public.invoices (organization_id, id),
  constraint chk_commission_entries_status check (status in ('accrued','paid','reversed'))
);
create index idx_commission_entries_org_member on public.commission_entries (organization_id, membership_id, status);
create trigger trg_commission_entries_created_by before insert on public.commission_entries for each row execute function app.tg_set_created_by();
create trigger trg_commission_entries_block_delete before delete on public.commission_entries for each row execute function app.tg_block_hard_delete();
-- status may transition (accrued->paid/reversed); monetary fields frozen:
create or replace function public.tg_commission_entries_freeze()
returns trigger language plpgsql as $$
begin
  if (new.base_amount, new.commission_amount, new.rate_snapshot, new.membership_id, new.currency) is distinct from
     (old.base_amount, old.commission_amount, old.rate_snapshot, old.membership_id, old.currency) then
    raise exception 'Commission entry is immutable except status.' using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;
create trigger trg_commission_entries_freeze before update on public.commission_entries for each row execute function public.tg_commission_entries_freeze();

-- Accrue commission on booking completion (idempotent), using the resolver.
create or replace function public.fn_accrue_commission(p_booking uuid, p_org uuid)
returns void language plpgsql as $$
declare v_service uuid; v_base numeric(14,2); v_ccy text; v_member uuid; d jsonb;
begin
  if exists (select 1 from public.commission_entries where organization_id = p_org and reference_booking_id = p_booking) then
    return;
  end if;
  select service_id, coalesce(price_snapshot,0), coalesce(currency,'USD')
    into v_service, v_base, v_ccy
  from public.bookings where id = p_booking and organization_id = p_org;
  -- primary staff resource assigned to the booking (if any)
  select r.membership_id into v_member
  from public.booking_resources br
  join public.resources r on r.id = br.resource_id and r.organization_id = br.organization_id
  where br.booking_id = p_booking and br.organization_id = p_org and r.membership_id is not null
  order by br.created_at limit 1;
  if v_member is null then return; end if;

  d := app.resolve_commission(p_org, v_service, v_base);
  if (d->>'commission_amount')::numeric <= 0 then return; end if;

  insert into public.commission_entries
    (organization_id, membership_id, reference_booking_id, base_amount, rate_snapshot, commission_amount, currency)
  values (p_org, v_member, p_booking, v_base, d, (d->>'commission_amount')::numeric, v_ccy);
end; $$;

create or replace function public.tg_bookings_accrue_commission()
returns trigger language plpgsql as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform public.fn_accrue_commission(new.id, new.organization_id);
  end if;
  return new;
end; $$;
create trigger trg_bookings_accrue_commission after update of status on public.bookings
  for each row execute function public.tg_bookings_accrue_commission();


-- =====================================================================
-- SECTION 002 — staff_compensation (config)
-- =====================================================================
create table public.staff_compensation (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  membership_id   uuid          not null,
  pay_type        text          not null default 'salary',     -- salary | hourly
  base_amount     numeric(14,2)  not null default 0,
  currency        text          not null default 'USD',
  effective_from  date          not null default current_date,
  is_active       boolean       not null default true,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_staff_compensation primary key (id),
  constraint fk_staff_compensation_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_staff_compensation_memberships foreign key (organization_id, membership_id) references public.memberships (organization_id, id) on delete cascade,
  constraint chk_staff_compensation_pay_type check (pay_type in ('salary','hourly'))
);
create index idx_staff_compensation_org_member on public.staff_compensation (organization_id, membership_id);
create trigger trg_staff_compensation_updated_at before update on public.staff_compensation for each row execute function app.tg_set_updated_at();
create trigger trg_staff_compensation_audit_cols before insert or update on public.staff_compensation for each row execute function app.tg_set_audit_columns();
create trigger trg_staff_compensation_audit after insert or update or delete on public.staff_compensation for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 003 — payroll_runs + payroll_items (freeze on approval)
-- =====================================================================
create table public.payroll_runs (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  branch_id       uuid,
  period_start    date          not null,
  period_end      date          not null,
  status          text          not null default 'draft',      -- draft | approved | paid
  currency        text          not null default 'USD',
  total_gross     numeric(14,2)  not null default 0,
  total_net       numeric(14,2)  not null default 0,
  approved_at     timestamptz,
  paid_at         timestamptz,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid,
  constraint pk_payroll_runs primary key (id),
  constraint fk_payroll_runs_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_payroll_runs_branches foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint uq_payroll_runs_org_id unique (organization_id, id),
  constraint chk_payroll_runs_status check (status in ('draft','approved','paid')),
  constraint chk_payroll_runs_period check (period_end >= period_start)
);
create index idx_payroll_runs_org on public.payroll_runs (organization_id, status);
-- Freeze monetary totals once approved (Rules 31/32); only status/paid_at move.
create or replace function public.tg_payroll_runs_freeze()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' and
     (new.total_gross, new.total_net, new.period_start, new.period_end, new.currency) is distinct from
     (old.total_gross, old.total_net, old.period_start, old.period_end, old.currency) then
    raise exception 'Approved payroll run is immutable (Rules 31/32).' using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;
create trigger trg_payroll_runs_freeze before update on public.payroll_runs for each row execute function public.tg_payroll_runs_freeze();
create trigger trg_payroll_runs_updated_at before update on public.payroll_runs for each row execute function app.tg_set_updated_at();
create trigger trg_payroll_runs_audit_cols before insert or update on public.payroll_runs for each row execute function app.tg_set_audit_columns();
create trigger trg_payroll_runs_audit after insert or update or delete on public.payroll_runs for each row execute function app.tg_write_audit();

create table public.payroll_items (
  id               uuid          not null default app.fn_uuid_v7(),
  organization_id  uuid          not null,
  payroll_run_id   uuid          not null,
  membership_id    uuid          not null,
  base_pay         numeric(14,2)  not null default 0,           -- snapshot
  commission_total numeric(14,2)  not null default 0,           -- snapshot (sum of included entries)
  deductions       numeric(14,2)  not null default 0,
  employer_cost    numeric(14,2)  not null default 0,
  gross_pay        numeric(14,2)  not null default 0,
  net_pay          numeric(14,2)  not null default 0,
  breakdown        jsonb         not null default '{}'::jsonb,  -- Rule 33: owns its snapshot
  created_at       timestamptz   not null default now(),
  created_by       uuid,
  constraint pk_payroll_items primary key (id),
  constraint fk_payroll_items_runs foreign key (organization_id, payroll_run_id) references public.payroll_runs (organization_id, id) on delete cascade,
  constraint fk_payroll_items_memberships foreign key (organization_id, membership_id) references public.memberships (organization_id, id)
);
create index idx_payroll_items_run on public.payroll_items (organization_id, payroll_run_id);
create trigger trg_payroll_items_created_by before insert on public.payroll_items for each row execute function app.tg_set_created_by();
create trigger trg_payroll_items_block_update before update on public.payroll_items for each row execute function app.tg_block_update();


-- =====================================================================
-- SECTION 004 — expenses (freeze on approval)
-- =====================================================================
create table public.expenses (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  branch_id       uuid,
  category        text,
  description     text          not null,
  amount          numeric(14,2)  not null,
  currency        text          not null default 'USD',
  status          text          not null default 'recorded',    -- recorded | approved | reimbursed
  vendor          text,
  membership_id   uuid,                                          -- reimburse-to staff (optional)
  incurred_at     date          not null default current_date,
  approved_at     timestamptz,
  reimbursed_at   timestamptz,
  receipt         jsonb         not null default '{}'::jsonb,
  metadata        jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_expenses primary key (id),
  constraint fk_expenses_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_expenses_branches foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint fk_expenses_memberships foreign key (organization_id, membership_id) references public.memberships (organization_id, id) on delete set null,
  constraint uq_expenses_org_id unique (organization_id, id),
  constraint chk_expenses_status check (status in ('recorded','approved','reimbursed')),
  constraint chk_expenses_amount check (amount > 0)
);
create index idx_expenses_org on public.expenses (organization_id, status);
create or replace function public.tg_expenses_freeze()
returns trigger language plpgsql as $$
begin
  if old.status <> 'recorded' and
     (new.amount, new.currency, new.description, new.category) is distinct from
     (old.amount, old.currency, old.description, old.category) then
    raise exception 'Approved expense is immutable (Rules 31/32).' using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;
create trigger trg_expenses_freeze before update on public.expenses for each row execute function public.tg_expenses_freeze();
create trigger trg_expenses_updated_at before update on public.expenses for each row execute function app.tg_set_updated_at();
create trigger trg_expenses_audit_cols before insert or update on public.expenses for each row execute function app.tg_set_audit_columns();
create trigger trg_expenses_audit after insert or update or delete on public.expenses for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 005 — Extend financial_ledger with TYPED refs (ADR-002 §3.5)
-- =====================================================================
alter table public.financial_ledger add column payroll_run_id uuid;
alter table public.financial_ledger add column expense_id     uuid;
alter table public.financial_ledger add constraint fk_financial_ledger_payroll
  foreign key (organization_id, payroll_run_id) references public.payroll_runs (organization_id, id);
alter table public.financial_ledger add constraint fk_financial_ledger_expenses
  foreign key (organization_id, expense_id) references public.expenses (organization_id, id);
alter table public.financial_ledger drop constraint chk_financial_ledger_type;
alter table public.financial_ledger add constraint chk_financial_ledger_type
  check (entry_type in ('invoice_issued','payment_received','refund_issued','invoice_void',
                        'payroll_paid','expense_paid'));


-- =====================================================================
-- SECTION 006 — Ledger population for payroll & expense payouts
-- =====================================================================
create or replace function public.tg_payroll_ledger()
returns trigger language plpgsql as $$
begin
  if new.status = 'paid' and old.status <> 'paid' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, payroll_run_id, occurred_at)
    values (new.organization_id, new.branch_id, 'payroll_paid', -new.total_net, new.currency, new.id, coalesce(new.paid_at, now()));
  end if;
  return null;
end; $$;
create trigger trg_payroll_runs_ledger after update of status on public.payroll_runs
  for each row execute function public.tg_payroll_ledger();

create or replace function public.tg_expense_ledger()
returns trigger language plpgsql as $$
begin
  if new.status = 'reimbursed' and old.status <> 'reimbursed' then
    insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, expense_id, occurred_at)
    values (new.organization_id, new.branch_id, 'expense_paid', -new.amount, new.currency, new.id, coalesce(new.reimbursed_at, now()));
  end if;
  return null;
end; $$;
create trigger trg_expenses_ledger after update of status on public.expenses
  for each row execute function public.tg_expense_ledger();


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
alter table public.commission_rules   enable row level security;
alter table public.commission_entries enable row level security;
alter table public.staff_compensation enable row level security;
alter table public.payroll_runs        enable row level security;
alter table public.payroll_items        enable row level security;
alter table public.expenses             enable row level security;

-- =====================================================================
-- END 0009_payroll_expenses
-- =====================================================================
