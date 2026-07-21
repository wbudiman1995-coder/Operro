-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0003_platform_entitlements
-- Milestone        3 — Platform Entitlements
-- Purpose          Establish Operro's commercial layer as PURE DATA:
--                  the Module and Feature catalogs, Plan preset bundles,
--                  per-organization Subscription, and per-organization
--                  Module/Feature state — plus the declarative resolver
--                  functions (has_module / has_feature / feature_config)
--                  that replace any "if plan === 'Enterprise'" logic.
-- Dependencies     0001 (helpers), 0002 (organizations).
-- Objects Created  Global catalogs : modules, features, plans,
--                                     plan_modules, plan_features
--                  Tenant tables   : subscriptions, organization_modules,
--                                     organization_features
--                  Functions       : app.has_active_subscription(),
--                                     app.has_module(text),
--                                     app.has_feature(text),
--                                     app.fn_feature_config(text)
-- Objects Modified None.
-- Indexes          FK / access-pattern + one partial-unique (one active
--                  subscription per org).
-- Constraints      pk_/fk_/uq_/chk_ per conventions. Simple FKs to GLOBAL
--                  catalogs (Rule 9/10: catalogs are not tenant-owned).
-- Triggers         updated_at + audit-columns on all tables; audit-log on
--                  tenant tables only (subscriptions, organization_modules,
--                  organization_features).
-- RLS Policies     RLS ENABLED (deny-all) on all new tables. Policies in M8.
-- Breaking Changes None.
-- Rollback         DROP the 8 tables (reverse dep order) + 4 functions.
-- Notes            Four layers stay distinct (Subscription -> Module ->
--                  Feature -> Permission). Enforcement resolves through
--                  org state + the resolver functions, never a plan name.
-- =====================================================================


-- =====================================================================
-- SECTION 001 — modules  (GLOBAL catalog)
-- =====================================================================
create table public.modules (
  id          uuid        not null default app.fn_uuid_v7(),
  key         text        not null,                       -- e.g. 'scheduling'
  name        text        not null,
  description text,
  category    text,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  constraint pk_modules primary key (id),
  constraint uq_modules_key unique (key)
);
create trigger trg_modules_updated_at before update on public.modules
  for each row execute function app.tg_set_updated_at();
create trigger trg_modules_audit_cols before insert or update on public.modules
  for each row execute function app.tg_set_audit_columns();


-- =====================================================================
-- SECTION 002 — features  (GLOBAL catalog; belongs to a module)
-- =====================================================================
create table public.features (
  id             uuid        not null default app.fn_uuid_v7(),
  module_id      uuid        not null,
  key            text        not null,                    -- e.g. 'route_optimization'
  name           text        not null,
  description    text,
  default_config jsonb       not null default '{}'::jsonb, -- default quotas/params
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid,
  deleted_at     timestamptz,
  constraint pk_features primary key (id),
  constraint uq_features_key unique (key),
  constraint fk_features_modules foreign key (module_id)
    references public.modules (id) on delete cascade
);
create index idx_features_module on public.features (module_id);
create trigger trg_features_updated_at before update on public.features
  for each row execute function app.tg_set_updated_at();
create trigger trg_features_audit_cols before insert or update on public.features
  for each row execute function app.tg_set_audit_columns();


-- =====================================================================
-- SECTION 003 — plans + preset bundles  (GLOBAL catalog)
-- =====================================================================
create table public.plans (
  id          uuid        not null default app.fn_uuid_v7(),
  key         text        not null,                       -- e.g. 'starter','pro','enterprise'
  name        text        not null,
  description text,
  is_public   boolean     not null default true,          -- self-serve vs. custom/enterprise
  is_active   boolean     not null default true,
  sort_order  integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  constraint pk_plans primary key (id),
  constraint uq_plans_key unique (key)
);
create trigger trg_plans_updated_at before update on public.plans
  for each row execute function app.tg_set_updated_at();
create trigger trg_plans_audit_cols before insert or update on public.plans
  for each row execute function app.tg_set_audit_columns();

create table public.plan_modules (
  plan_id    uuid not null,
  module_id  uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint pk_plan_modules primary key (plan_id, module_id),
  constraint fk_plan_modules_plans   foreign key (plan_id)   references public.plans (id)   on delete cascade,
  constraint fk_plan_modules_modules foreign key (module_id) references public.modules (id) on delete cascade
);

create table public.plan_features (
  plan_id    uuid  not null,
  feature_id uuid  not null,
  config     jsonb not null default '{}'::jsonb,           -- plan's default for this feature
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint pk_plan_features primary key (plan_id, feature_id),
  constraint fk_plan_features_plans    foreign key (plan_id)    references public.plans (id)    on delete cascade,
  constraint fk_plan_features_features foreign key (feature_id) references public.features (id) on delete cascade
);


-- =====================================================================
-- SECTION 004 — subscriptions  (TENANT: what the org purchased)
-- =====================================================================
create table public.subscriptions (
  id                   uuid        not null default app.fn_uuid_v7(),
  organization_id      uuid        not null,
  plan_id              uuid,                               -- null = custom/enterprise arrangement
  status               text        not null default 'trialing',
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at            timestamptz,
  external_ref         text,                               -- billing provider id
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  deleted_at           timestamptz,
  constraint pk_subscriptions primary key (id),
  constraint fk_subscriptions_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_subscriptions_plans foreign key (plan_id)
    references public.plans (id),
  constraint chk_subscriptions_status
    check (status in ('trialing','active','past_due','paused','canceled'))
);
create index idx_subscriptions_organization on public.subscriptions (organization_id);
-- At most one live subscription per organization.
create unique index uidx_subscriptions_active_org on public.subscriptions (organization_id)
  where status in ('trialing','active','past_due') and deleted_at is null;

create trigger trg_subscriptions_updated_at before update on public.subscriptions
  for each row execute function app.tg_set_updated_at();
create trigger trg_subscriptions_audit_cols before insert or update on public.subscriptions
  for each row execute function app.tg_set_audit_columns();
create trigger trg_subscriptions_audit after insert or update or delete on public.subscriptions
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 005 — organization_modules  (TENANT state)
-- =====================================================================
create table public.organization_modules (
  organization_id uuid        not null,
  module_id       uuid        not null,
  enabled         boolean     not null default true,
  source          text        not null default 'plan',    -- 'plan' | 'override'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint pk_organization_modules primary key (organization_id, module_id),
  constraint fk_organization_modules_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_organization_modules_modules foreign key (module_id)
    references public.modules (id) on delete cascade,
  constraint chk_organization_modules_source check (source in ('plan','override'))
);
create trigger trg_organization_modules_updated_at before update on public.organization_modules
  for each row execute function app.tg_set_updated_at();
create trigger trg_organization_modules_audit_cols before insert or update on public.organization_modules
  for each row execute function app.tg_set_audit_columns();
create trigger trg_organization_modules_audit after insert or update or delete on public.organization_modules
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 006 — organization_features  (TENANT state)
-- =====================================================================
create table public.organization_features (
  organization_id uuid        not null,
  feature_id      uuid        not null,
  enabled         boolean     not null default true,
  config          jsonb       not null default '{}'::jsonb, -- org-specific quota/param override
  source          text        not null default 'plan',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint pk_organization_features primary key (organization_id, feature_id),
  constraint fk_organization_features_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_organization_features_features foreign key (feature_id)
    references public.features (id) on delete cascade,
  constraint chk_organization_features_source check (source in ('plan','override'))
);
create trigger trg_organization_features_updated_at before update on public.organization_features
  for each row execute function app.tg_set_updated_at();
create trigger trg_organization_features_audit_cols before insert or update on public.organization_features
  for each row execute function app.tg_set_audit_columns();
create trigger trg_organization_features_audit after insert or update or delete on public.organization_features
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 007 — Declarative resolver functions  (app schema)
-- =====================================================================
-- SECURITY DEFINER: they read org state to answer entitlement questions and
-- must see it regardless of the caller's RLS. Each is scoped strictly to the
-- active organization; platform admins bypass. These are the ONLY sanctioned
-- way to gate on entitlements — never branch on a plan name.

create or replace function app.has_active_subscription()
returns boolean
security definer set search_path = app, public
language sql stable as $$
  select app.is_platform_admin() or exists (
    select 1 from public.subscriptions s
    where s.organization_id = app.fn_active_organization()
      and s.deleted_at is null
      and s.status in ('trialing','active','past_due'));
$$;

create or replace function app.has_module(module_key text)
returns boolean
security definer set search_path = app, public
language sql stable as $$
  select app.is_platform_admin() or (
    app.has_active_subscription() and exists (
      select 1
      from public.organization_modules om
      join public.modules m on m.id = om.module_id
      where om.organization_id = app.fn_active_organization()
        and om.enabled and m.is_active and m.key = module_key));
$$;

create or replace function app.has_feature(feature_key text)
returns boolean
security definer set search_path = app, public
language sql stable as $$
  select app.is_platform_admin() or exists (
    select 1
    from public.organization_features of
    join public.features f on f.id = of.feature_id
    join public.modules  m on m.id = f.module_id
    where of.organization_id = app.fn_active_organization()
      and of.enabled and f.is_active and f.key = feature_key
      and app.has_module(m.key));      -- feature requires its parent module (+ subscription)
$$;

create or replace function app.fn_feature_config(feature_key text)
returns jsonb
security definer set search_path = app, public
language sql stable as $$
  -- org override wins over the catalog default.
  select coalesce(
    (select of.config from public.organization_features of
       join public.features f on f.id = of.feature_id
      where of.organization_id = app.fn_active_organization() and f.key = feature_key),
    (select f.default_config from public.features f where f.key = feature_key),
    '{}'::jsonb);
$$;


-- =====================================================================
-- SECTION 008 — Seed GLOBAL catalogs (platform data, not tenant data)
-- =====================================================================
insert into public.modules (key, name, category, sort_order) values
  ('scheduling',   'Scheduling',    'operations', 10),
  ('crm',          'CRM',           'commercial', 20),
  ('inventory',    'Inventory',     'operations', 30),
  ('finance',      'Finance',       'financial',  40),
  ('payroll',      'Payroll',       'financial',  50),
  ('pos',          'POS',           'financial',  60),
  ('reports',      'Reports',       'insight',    70),
  ('marketing',    'Marketing',     'commercial', 80),
  ('notifications','Notifications', 'platform',   90);

insert into public.features (module_id, key, name, default_config)
select m.id, v.key, v.name, v.cfg::jsonb
from (values
  ('scheduling','online_booking',     'Online Booking',      '{}'),
  ('scheduling','recurring_bookings',  'Recurring Bookings',  '{}'),
  ('scheduling','route_optimization',  'Route Optimization',  '{"max_stops":25}'),
  ('inventory', 'low_stock_alerts',    'Low Stock Alerts',    '{}'),
  ('crm',       'customer_portal',     'Customer Portal',     '{}'),
  ('finance',   'multi_currency',      'Multi-Currency',      '{}'),
  ('reports',   'advanced_reports',    'Advanced Reports',    '{}')
) as v(module_key, key, name, cfg)
join public.modules m on m.key = v.module_key;

insert into public.plans (key, name, is_public, sort_order) values
  ('starter',   'Starter',    true,  10),
  ('pro',       'Pro',        true,  20),
  ('enterprise','Enterprise', false, 30);

-- Preset module bundles per plan.
insert into public.plan_modules (plan_id, module_id)
select p.id, m.id from public.plans p join public.modules m on true
where (p.key='starter'    and m.key in ('scheduling','crm'))
   or (p.key='pro'        and m.key in ('scheduling','crm','inventory','finance','pos','reports'))
   or (p.key='enterprise');   -- enterprise = every module

-- Preset feature bundles per plan.
insert into public.plan_features (plan_id, feature_id)
select p.id, f.id from public.plans p join public.features f on true
where (p.key='starter'    and f.key in ('online_booking'))
   or (p.key='pro'        and f.key in ('online_booking','recurring_bookings','advanced_reports','low_stock_alerts'))
   or (p.key='enterprise');   -- enterprise = every feature


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
alter table public.modules               enable row level security;
alter table public.features              enable row level security;
alter table public.plans                 enable row level security;
alter table public.plan_modules          enable row level security;
alter table public.plan_features         enable row level security;
alter table public.subscriptions         enable row level security;
alter table public.organization_modules  enable row level security;
alter table public.organization_features enable row level security;

-- =====================================================================
-- END 0003_platform_entitlements
-- =====================================================================
