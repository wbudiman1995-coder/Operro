-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0007_customer_programs
-- Milestone        4B — Customer Programs
-- Purpose          Five INDEPENDENT commercial systems on the operational
--                  foundation: recurring Membership Plans, prepaid Packages
--                  (session ledger, generalizing HomePaw), Loyalty (points
--                  ledger), Wallet/Credits (money ledger), and Referrals.
--                  Every balance is DERIVED from an immutable ledger
--                  (Rules 24/25); sessions auto-consume on booking completion
--                  (Rule 26).
-- Dependencies     0001, 0002, 0004 (customers), 0005 (bookings), 0006
--                  (ledger helpers app.tg_block_update / tg_set_created_by).
-- Objects Created  membership_plans, customer_memberships, packages,
--                  customer_packages, customer_package_ledger,
--                  loyalty_accounts, loyalty_ledger, wallet_accounts,
--                  wallet_ledger, referrals  (+ apply/consume fns & triggers)
-- Constraints      COMPOSITE FKs; immutable ledgers; derived-balance caches.
-- Triggers         Per-ledger: block update+delete, stamp created_by, apply
--                  to balance cache. Package consumption on booking complete.
-- RLS Policies     RLS ENABLED (deny-all). Policies in M8. Module gating
--                  (M8): all -> 'membership' (or 'crm').
-- Breaking Changes None.
-- Rollback         DROP the 10 tables + program functions (reverse dep order).
-- Notes            Referrals are kept SEPARATE from loyalty (no mixing).
--                  Reward issuance from referrals is an explicit app action
--                  (may write a wallet_ledger row), not auto-coupled here.
-- =====================================================================


-- =====================================================================
-- SECTION 001 — Membership Plans (catalog) + enrollments
-- =====================================================================
create table public.membership_plans (
  id               uuid          not null default app.fn_uuid_v7(),
  organization_id  uuid          not null,
  name             text          not null,
  description      text,
  billing_interval text          not null default 'month',   -- week|month|year
  price            numeric(14,2)  not null default 0,
  currency         text          not null default 'USD',
  benefits         jsonb          not null default '{}'::jsonb, -- discounts / included services
  is_active        boolean        not null default true,
  metadata         jsonb          not null default '{}'::jsonb,
  created_at       timestamptz    not null default now(),
  updated_at       timestamptz    not null default now(),
  created_by       uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_membership_plans primary key (id),
  constraint fk_membership_plans_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint uq_membership_plans_org_id unique (organization_id, id),
  constraint uq_membership_plans_org_name unique (organization_id, name),
  constraint chk_membership_plans_interval check (billing_interval in ('week','month','year'))
);
create index idx_membership_plans_org on public.membership_plans (organization_id);
create trigger trg_membership_plans_updated_at before update on public.membership_plans for each row execute function app.tg_set_updated_at();
create trigger trg_membership_plans_audit_cols before insert or update on public.membership_plans for each row execute function app.tg_set_audit_columns();
create trigger trg_membership_plans_audit after insert or update or delete on public.membership_plans for each row execute function app.tg_write_audit();

create table public.customer_memberships (
  id                 uuid        not null default app.fn_uuid_v7(),
  organization_id    uuid        not null,
  customer_id        uuid        not null,
  membership_plan_id uuid        not null,
  status             text        not null default 'active',   -- active|paused|canceled|expired
  started_at         timestamptz not null default now(),
  current_period_end timestamptz,
  cancel_at          timestamptz,
  external_ref       text,
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_customer_memberships primary key (id),
  constraint fk_customer_memberships_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_customer_memberships_customers foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint fk_customer_memberships_plans foreign key (organization_id, membership_plan_id)
    references public.membership_plans (organization_id, id),
  constraint chk_customer_memberships_status check (status in ('active','paused','canceled','expired'))
);
create index idx_customer_memberships_org_customer on public.customer_memberships (organization_id, customer_id);
create unique index uidx_customer_memberships_active
  on public.customer_memberships (organization_id, customer_id, membership_plan_id)
  where status = 'active' and deleted_at is null;
create trigger trg_customer_memberships_updated_at before update on public.customer_memberships for each row execute function app.tg_set_updated_at();
create trigger trg_customer_memberships_audit_cols before insert or update on public.customer_memberships for each row execute function app.tg_set_audit_columns();
create trigger trg_customer_memberships_audit after insert or update or delete on public.customer_memberships for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 002 — Packages (catalog) + customer packages + SESSION LEDGER
-- =====================================================================
create table public.packages (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  name            text          not null,
  description     text,
  service_id      uuid,                                        -- null = applies to any service
  total_sessions  integer       not null,
  price           numeric(14,2)  not null default 0,
  currency        text          not null default 'USD',
  validity_days   integer,                                     -- null = no expiry
  rollover_policy text          not null default 'none',       -- none|rollover
  is_active       boolean        not null default true,
  metadata        jsonb          not null default '{}'::jsonb,
  created_at      timestamptz    not null default now(),
  updated_at      timestamptz    not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_packages primary key (id),
  constraint fk_packages_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_packages_services foreign key (organization_id, service_id)
    references public.service_catalog (organization_id, id) on delete set null,
  constraint uq_packages_org_id unique (organization_id, id),
  constraint chk_packages_sessions check (total_sessions > 0),
  constraint chk_packages_rollover check (rollover_policy in ('none','rollover'))
);
create index idx_packages_org on public.packages (organization_id);
create trigger trg_packages_updated_at before update on public.packages for each row execute function app.tg_set_updated_at();
create trigger trg_packages_audit_cols before insert or update on public.packages for each row execute function app.tg_set_audit_columns();
create trigger trg_packages_audit after insert or update or delete on public.packages for each row execute function app.tg_write_audit();

create table public.customer_packages (
  id                 uuid        not null default app.fn_uuid_v7(),
  organization_id    uuid        not null,
  customer_id        uuid        not null,
  package_id         uuid        not null,
  service_id         uuid,                                     -- snapshot of applicable service (nullable)
  sessions_remaining integer     not null default 0,           -- DERIVED cache from customer_package_ledger
  purchased_at       timestamptz not null default now(),
  expires_at         timestamptz,
  status             text        not null default 'active',    -- active|exhausted|expired|canceled
  source_ref         text,
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_customer_packages primary key (id),
  constraint fk_customer_packages_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_customer_packages_customers foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint fk_customer_packages_packages foreign key (organization_id, package_id)
    references public.packages (organization_id, id),
  constraint uq_customer_packages_org_id unique (organization_id, id),
  constraint chk_customer_packages_status check (status in ('active','exhausted','expired','canceled'))
);
create index idx_customer_packages_org_customer on public.customer_packages (organization_id, customer_id, status);
create trigger trg_customer_packages_updated_at before update on public.customer_packages for each row execute function app.tg_set_updated_at();
create trigger trg_customer_packages_audit_cols before insert or update on public.customer_packages for each row execute function app.tg_set_audit_columns();
create trigger trg_customer_packages_audit after insert or update or delete on public.customer_packages for each row execute function app.tg_write_audit();

-- Immutable session ledger; sessions_remaining is derived from it.
create table public.customer_package_ledger (
  id                   uuid        not null default app.fn_uuid_v7(),
  organization_id      uuid        not null,
  customer_package_id  uuid        not null,
  delta                integer     not null,                   -- +total on purchase, -1 per consumption
  reason               text        not null,                   -- purchase|consumption|adjustment|expiry|refund
  reference_booking_id uuid,
  notes                text,
  occurred_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  created_by           uuid,
  constraint pk_customer_package_ledger primary key (id),
  constraint fk_cpl_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_cpl_customer_packages foreign key (organization_id, customer_package_id)
    references public.customer_packages (organization_id, id) on delete cascade,
  constraint fk_cpl_booking foreign key (organization_id, reference_booking_id)
    references public.bookings (organization_id, id),
  constraint chk_cpl_reason check (reason in ('purchase','consumption','adjustment','expiry','refund')),
  constraint chk_cpl_delta_nonzero check (delta <> 0)
);
create index idx_cpl_org_package on public.customer_package_ledger (organization_id, customer_package_id, occurred_at);

create or replace function public.tg_package_apply_ledger()
returns trigger language plpgsql as $$
begin
  update public.customer_packages
     set sessions_remaining = sessions_remaining + new.delta,
         updated_at = now()
   where id = new.customer_package_id and organization_id = new.organization_id;
  return new;
end; $$;
create trigger trg_cpl_created_by before insert on public.customer_package_ledger for each row execute function app.tg_set_created_by();
create trigger trg_cpl_block_update before update on public.customer_package_ledger for each row execute function app.tg_block_update();
create trigger trg_cpl_block_delete before delete on public.customer_package_ledger for each row execute function app.tg_block_hard_delete();
create trigger trg_cpl_apply after insert on public.customer_package_ledger for each row execute function public.tg_package_apply_ledger();

-- Auto-consume a package session when a booking completes (idempotent, near-data).
create or replace function public.fn_consume_package_session(p_booking uuid, p_org uuid)
returns void language plpgsql as $$
declare v_customer uuid; v_service uuid; v_pkg uuid;
begin
  if exists (select 1 from public.customer_package_ledger
             where organization_id = p_org and reference_booking_id = p_booking and reason = 'consumption') then
    return;  -- already consumed for this booking
  end if;
  select customer_id, service_id into v_customer, v_service
  from public.bookings where id = p_booking and organization_id = p_org;
  if v_customer is null then return; end if;

  select cp.id into v_pkg
  from public.customer_packages cp
  where cp.organization_id = p_org and cp.customer_id = v_customer
    and cp.status = 'active' and cp.sessions_remaining > 0
    and (cp.expires_at is null or cp.expires_at > now())
    and (cp.service_id is null or cp.service_id = v_service)
  order by cp.expires_at nulls last, cp.purchased_at   -- soonest-expiring first
  limit 1;
  if v_pkg is null then return; end if;                 -- no package: normal payment path

  insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, reference_booking_id, notes)
  values (p_org, v_pkg, -1, 'consumption', p_booking, 'auto: booking completion');

  update public.customer_packages set status = 'exhausted'
   where id = v_pkg and organization_id = p_org and sessions_remaining <= 0;
end; $$;

create or replace function public.tg_bookings_consume_package()
returns trigger language plpgsql as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform public.fn_consume_package_session(new.id, new.organization_id);
  end if;
  return new;
end; $$;
create trigger trg_bookings_consume_package after update of status on public.bookings
  for each row execute function public.tg_bookings_consume_package();


-- =====================================================================
-- SECTION 003 — Loyalty (account + POINTS LEDGER)
-- =====================================================================
create table public.loyalty_accounts (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  customer_id     uuid          not null,
  points_balance  numeric(14,2)  not null default 0,           -- DERIVED cache
  created_at      timestamptz    not null default now(),
  updated_at      timestamptz    not null default now(),
  created_by      uuid, updated_by uuid,
  constraint pk_loyalty_accounts primary key (id),
  constraint fk_loyalty_accounts_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_loyalty_accounts_customers foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint uq_loyalty_accounts_org_id unique (organization_id, id),
  constraint uq_loyalty_accounts_org_customer unique (organization_id, customer_id)
);
create trigger trg_loyalty_accounts_updated_at before update on public.loyalty_accounts for each row execute function app.tg_set_updated_at();
create trigger trg_loyalty_accounts_audit_cols before insert or update on public.loyalty_accounts for each row execute function app.tg_set_audit_columns();

create table public.loyalty_ledger (
  id               uuid          not null default app.fn_uuid_v7(),
  organization_id  uuid          not null,
  loyalty_account_id uuid        not null,
  delta            numeric(14,2)  not null,                     -- +earn, -redeem/expire
  reason           text          not null,                     -- earn|redeem|expire|adjustment
  reference        jsonb          not null default '{}'::jsonb, -- {booking_id|order_id|...}
  occurred_at      timestamptz    not null default now(),
  created_at       timestamptz    not null default now(),
  created_by       uuid,
  constraint pk_loyalty_ledger primary key (id),
  constraint fk_loyalty_ledger_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_loyalty_ledger_accounts foreign key (organization_id, loyalty_account_id)
    references public.loyalty_accounts (organization_id, id) on delete cascade,
  constraint chk_loyalty_ledger_reason check (reason in ('earn','redeem','expire','adjustment')),
  constraint chk_loyalty_ledger_delta check (delta <> 0)
);
create index idx_loyalty_ledger_org_account on public.loyalty_ledger (organization_id, loyalty_account_id, occurred_at);

create or replace function public.tg_loyalty_apply_ledger()
returns trigger language plpgsql as $$
begin
  update public.loyalty_accounts
     set points_balance = points_balance + new.delta, updated_at = now()
   where id = new.loyalty_account_id and organization_id = new.organization_id;
  return new;
end; $$;
create trigger trg_loyalty_ledger_created_by before insert on public.loyalty_ledger for each row execute function app.tg_set_created_by();
create trigger trg_loyalty_ledger_block_update before update on public.loyalty_ledger for each row execute function app.tg_block_update();
create trigger trg_loyalty_ledger_block_delete before delete on public.loyalty_ledger for each row execute function app.tg_block_hard_delete();
create trigger trg_loyalty_ledger_apply after insert on public.loyalty_ledger for each row execute function public.tg_loyalty_apply_ledger();


-- =====================================================================
-- SECTION 004 — Wallet / Credits (account + MONEY LEDGER)
-- =====================================================================
create table public.wallet_accounts (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  customer_id     uuid          not null,
  currency        text          not null default 'USD',
  balance         numeric(14,2)  not null default 0,            -- DERIVED cache
  created_at      timestamptz    not null default now(),
  updated_at      timestamptz    not null default now(),
  created_by      uuid, updated_by uuid,
  constraint pk_wallet_accounts primary key (id),
  constraint fk_wallet_accounts_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_wallet_accounts_customers foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint uq_wallet_accounts_org_id unique (organization_id, id),
  constraint uq_wallet_accounts_org_customer_ccy unique (organization_id, customer_id, currency)
);
create trigger trg_wallet_accounts_updated_at before update on public.wallet_accounts for each row execute function app.tg_set_updated_at();
create trigger trg_wallet_accounts_audit_cols before insert or update on public.wallet_accounts for each row execute function app.tg_set_audit_columns();

create table public.wallet_ledger (
  id               uuid          not null default app.fn_uuid_v7(),
  organization_id  uuid          not null,
  wallet_account_id uuid         not null,
  delta            numeric(14,2)  not null,                     -- +topup/refund/promo, -payment
  reason           text          not null,                     -- topup|refund|promo|payment|adjustment|expire
  reference        jsonb          not null default '{}'::jsonb,
  occurred_at      timestamptz    not null default now(),
  created_at       timestamptz    not null default now(),
  created_by       uuid,
  constraint pk_wallet_ledger primary key (id),
  constraint fk_wallet_ledger_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_wallet_ledger_accounts foreign key (organization_id, wallet_account_id)
    references public.wallet_accounts (organization_id, id) on delete cascade,
  constraint chk_wallet_ledger_reason check (reason in ('topup','refund','promo','payment','adjustment','expire')),
  constraint chk_wallet_ledger_delta check (delta <> 0)
);
create index idx_wallet_ledger_org_account on public.wallet_ledger (organization_id, wallet_account_id, occurred_at);

create or replace function public.tg_wallet_apply_ledger()
returns trigger language plpgsql as $$
begin
  update public.wallet_accounts
     set balance = balance + new.delta, updated_at = now()
   where id = new.wallet_account_id and organization_id = new.organization_id;
  return new;
end; $$;
create trigger trg_wallet_ledger_created_by before insert on public.wallet_ledger for each row execute function app.tg_set_created_by();
create trigger trg_wallet_ledger_block_update before update on public.wallet_ledger for each row execute function app.tg_block_update();
create trigger trg_wallet_ledger_block_delete before delete on public.wallet_ledger for each row execute function app.tg_block_hard_delete();
create trigger trg_wallet_ledger_apply after insert on public.wallet_ledger for each row execute function public.tg_wallet_apply_ledger();


-- =====================================================================
-- SECTION 005 — Referrals (separate domain; NOT mixed with loyalty)
-- =====================================================================
create table public.referrals (
  id                   uuid        not null default app.fn_uuid_v7(),
  organization_id      uuid        not null,
  referrer_customer_id uuid        not null,
  referred_customer_id uuid,                                    -- set on conversion
  referred_contact     jsonb       not null default '{}'::jsonb, -- name/email/phone before signup
  code                 text,
  status               text        not null default 'pending',  -- pending|converted|rewarded|expired
  reward_config        jsonb       not null default '{}'::jsonb,
  converted_at         timestamptz,
  rewarded_at          timestamptz,
  metadata             jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_referrals primary key (id),
  constraint fk_referrals_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_referrals_referrer foreign key (organization_id, referrer_customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint fk_referrals_referred foreign key (organization_id, referred_customer_id)
    references public.customers (organization_id, id) on delete set null,
  constraint uq_referrals_org_code unique (organization_id, code),
  constraint chk_referrals_status check (status in ('pending','converted','rewarded','expired'))
);
create index idx_referrals_org_referrer on public.referrals (organization_id, referrer_customer_id);
create trigger trg_referrals_updated_at before update on public.referrals for each row execute function app.tg_set_updated_at();
create trigger trg_referrals_audit_cols before insert or update on public.referrals for each row execute function app.tg_set_audit_columns();
create trigger trg_referrals_audit after insert or update or delete on public.referrals for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
alter table public.membership_plans        enable row level security;
alter table public.customer_memberships     enable row level security;
alter table public.packages                 enable row level security;
alter table public.customer_packages        enable row level security;
alter table public.customer_package_ledger  enable row level security;
alter table public.loyalty_accounts         enable row level security;
alter table public.loyalty_ledger           enable row level security;
alter table public.wallet_accounts          enable row level security;
alter table public.wallet_ledger            enable row level security;
alter table public.referrals                enable row level security;

-- =====================================================================
-- END 0007_customer_programs
-- =====================================================================
