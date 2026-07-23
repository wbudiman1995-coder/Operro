-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0004_commercial_core
-- Milestone        4A — Commercial Domain (core: CRM + catalogs)
-- Purpose          The long-lived commercial entities every vertical shares:
--                  the generic Party/Customer, generic Pet, and the two
--                  independent offering catalogs (Service, Product). Kept
--                  CRM-ready and vertical-neutral (Rule: no grooming-specific
--                  fields). Customer Programs (memberships, packages, loyalty,
--                  credits, referrals) are Milestone 4B.
-- Dependencies     0001 (helpers), 0002 (organizations, users), 0003 present.
-- Objects Created  TABLES public.customers, public.pets,
--                  public.service_catalog, public.product_catalog.
-- Objects Modified None.
-- Indexes          FK / lookup indexes; partial-unique product SKU per org.
-- Constraints      pk_/fk_/uq_/chk_. COMPOSITE FKs for tenant integrity
--                  (Rule 10): pets -> customers on (organization_id, id).
-- Triggers         updated_at + audit-columns + audit-log on all (tenant).
-- RLS Policies     RLS ENABLED (deny-all). Policies in M8. Module gating
--                  (noted, enforced in M8): customers/pets -> crm;
--                  service_catalog -> scheduling; product_catalog -> pos.
-- Breaking Changes None.
-- Rollback         DROP TABLE product_catalog, service_catalog, pets, customers.
-- Notes            customers is a CRM entity, NOT an auth identity. Portal
--                  access is an OPTIONAL link to a global user
--                  (customers.portal_user_id), never required.
-- =====================================================================


-- =====================================================================
-- SECTION 001 — customers  (Party — generic, CRM-ready)
-- =====================================================================
create table public.customers (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  party_type      text        not null default 'individual',  -- individual | business (vet/retail accounts)
  display_name    text        not null,
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  address         jsonb       not null default '{}'::jsonb,    -- generic postal address
  latitude        numeric(9,6),                                -- optional, for home-service fulfillment
  longitude       numeric(9,6),
  status          text        not null default 'active',       -- lead | active | inactive | archived
  source          text,                                        -- acquisition source
  tags            jsonb       not null default '[]'::jsonb,
  notes           text,
  metadata        jsonb       not null default '{}'::jsonb,
  portal_user_id  uuid,                                        -- OPTIONAL global-user link for portal access
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_customers primary key (id),
  constraint fk_customers_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_customers_portal_user foreign key (portal_user_id)
    references public.users (id) on delete set null,
  constraint uq_customers_org_id unique (organization_id, id),        -- composite-FK target
  constraint uq_customers_org_portal_user unique (organization_id, portal_user_id),
  constraint chk_customers_party_type check (party_type in ('individual','business')),
  constraint chk_customers_status check (status in ('lead','active','inactive','archived'))
);
create index idx_customers_organization on public.customers (organization_id);
create index idx_customers_org_email on public.customers (organization_id, lower(email));
create index idx_customers_org_phone on public.customers (organization_id, phone);

create trigger trg_customers_updated_at before update on public.customers
  for each row execute function app.tg_set_updated_at();
create trigger trg_customers_audit_cols before insert or update on public.customers
  for each row execute function app.tg_set_audit_columns();
create trigger trg_customers_audit after insert or update or delete on public.customers
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 002 — pets  (generic across verticals)
-- =====================================================================
create table public.pets (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  customer_id     uuid        not null,                         -- owner (multi-pet households supported)
  name            text        not null,
  species         text        not null default 'dog',          -- generic: dog|cat|rabbit|... (not hardcoded)
  breed           text,
  sex             text        not null default 'unknown',
  birthdate       date,
  weight_kg       numeric(6,2),
  color           text,
  temperament     text,
  notes           text,
  medical_flags   jsonb       not null default '{}'::jsonb,     -- allergies/conditions; full vet records = vet extension
  status          text        not null default 'active',        -- active | deceased | archived
  deceased_at     date,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_pets primary key (id),
  constraint fk_pets_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  -- composite FK: pet's owner MUST be in the same organization (tenant integrity)
  constraint fk_pets_customers foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade,
  constraint uq_pets_org_id unique (organization_id, id),             -- composite-FK target (bookings/vet)
  constraint chk_pets_sex check (sex in ('male','female','unknown')),
  constraint chk_pets_status check (status in ('active','deceased','archived'))
);
create index idx_pets_org_customer on public.pets (organization_id, customer_id);

create trigger trg_pets_updated_at before update on public.pets
  for each row execute function app.tg_set_updated_at();
create trigger trg_pets_audit_cols before insert or update on public.pets
  for each row execute function app.tg_set_audit_columns();
create trigger trg_pets_audit after insert or update or delete on public.pets
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 003 — service_catalog  (offerings: duration/skill/SOP/photos)
-- =====================================================================
create table public.service_catalog (
  id                uuid        not null default app.fn_uuid_v7(),
  organization_id   uuid        not null,
  name              text        not null,
  description       text,
  category          text,
  duration_minutes  integer     not null default 60,
  base_price        numeric(14,2) not null default 0,
  currency          text        not null default 'USD',        -- org base currency applied at creation
  required_skill    text,                                       -- skill key matched to resource skills (M5)
  required_photos   integer     not null default 0,
  sop               jsonb       not null default '{}'::jsonb,   -- dynamic SOP (freeform config)
  commission_config jsonb       not null default '{}'::jsonb,
  fulfillment_modes jsonb       not null default '["in_store","home"]'::jsonb,  -- offered modes
  is_active         boolean     not null default true,
  metadata          jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid,
  deleted_at        timestamptz,
  constraint pk_service_catalog primary key (id),
  constraint fk_service_catalog_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint uq_service_catalog_org_id unique (organization_id, id),          -- composite-FK target
  constraint uq_service_catalog_org_name unique (organization_id, name),
  constraint chk_service_catalog_duration check (duration_minutes > 0),
  constraint chk_service_catalog_price check (base_price >= 0)
);
create index idx_service_catalog_organization on public.service_catalog (organization_id);

create trigger trg_service_catalog_updated_at before update on public.service_catalog
  for each row execute function app.tg_set_updated_at();
create trigger trg_service_catalog_audit_cols before insert or update on public.service_catalog
  for each row execute function app.tg_set_audit_columns();
create trigger trg_service_catalog_audit after insert or update or delete on public.service_catalog
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 004 — product_catalog  (SKU/supplier/cost/price)
-- =====================================================================
create table public.product_catalog (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  sku             text,
  name            text        not null,
  description     text,
  category        text,
  barcode         text,
  unit            text        not null default 'each',
  cost_price      numeric(14,2),
  selling_price   numeric(14,2) not null default 0,
  currency        text        not null default 'USD',
  supplier        text,                                          -- supplier name/ref (full supplier entity = future)
  is_active       boolean     not null default true,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_product_catalog primary key (id),
  constraint fk_product_catalog_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint uq_product_catalog_org_id unique (organization_id, id),          -- composite-FK target
  constraint chk_product_catalog_price check (selling_price >= 0)
);
create index idx_product_catalog_organization on public.product_catalog (organization_id);
-- SKU unique per org when present (nulls allowed / not unique).
create unique index uidx_product_catalog_org_sku on public.product_catalog (organization_id, sku)
  where sku is not null and deleted_at is null;

create trigger trg_product_catalog_updated_at before update on public.product_catalog
  for each row execute function app.tg_set_updated_at();
create trigger trg_product_catalog_audit_cols before insert or update on public.product_catalog
  for each row execute function app.tg_set_audit_columns();
create trigger trg_product_catalog_audit after insert or update or delete on public.product_catalog
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
alter table public.customers        enable row level security;
alter table public.pets             enable row level security;
alter table public.service_catalog  enable row level security;
alter table public.product_catalog  enable row level security;

-- =====================================================================
-- END 0004_commercial_core
-- =====================================================================
