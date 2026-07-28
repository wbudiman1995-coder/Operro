-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0002_identity_access
-- Milestone        2 — Identity & Access
-- Purpose          Create the identity and authorization core: the global
--                  User, the tenant Organization + Branch, the Membership
--                  bridge that carries a user's Role per organization, and
--                  the dynamic RBAC catalog (Roles, global Permissions,
--                  Role-Permission grants, Membership-Branch access).
-- Dependencies     0001_extensions_and_helpers (app schema + helpers).
--                  Supabase auth.users (referenced by public.users).
-- Objects Created  TABLES public.organizations, public.branches,
--                  public.users, public.roles, public.memberships,
--                  public.permissions, public.role_permissions,
--                  public.membership_branch_access.
-- Objects Modified SECTION 000 renames Milestone 1 objects to match the
--                  approved Platform Naming Conventions (functions, indexes,
--                  constraints). Non-breaking: those objects have no
--                  consumers yet.
-- Indexes          FK / access-pattern indexes per table (see sections).
-- Constraints      pk_/fk_/uq_/chk_ per naming conventions. Tenant integrity
--                  via COMPOSITE foreign keys (ADR-001 D2).
-- Triggers         updated_at + audit-column stamping on all tables;
--                  audit-log write on tenant tables only (those with an
--                  organization_id). Global/root tables (organizations,
--                  users, permissions) get no audit-log trigger.
-- RLS Policies     RLS is ENABLED on every public table here as a safety
--                  default (deny-all, no policies). Policies are authored in
--                  Milestone 8. See SECTION 099.
-- Breaking Changes None to consumers. Foundation function renames are
--                  internal (zero consumers pre-Milestone-2).
-- Rollback         DROP TABLE (in reverse dependency order) the 8 tables;
--                  re-apply 0001 naming if reverting SECTION 000.
-- Notes            public.users is GLOBAL (no organization_id) — Slack-style
--                  identity. Authorization lives on memberships, not users.
-- =====================================================================


-- =====================================================================
-- SECTION 000 — Milestone 1 Reconciliation (align to naming conventions)
-- =====================================================================
-- Indexes
alter index app.audit_log_org_time_idx rename to idx_audit_log_org_time;
alter index app.audit_log_entity_idx   rename to idx_audit_log_entity;
-- Constraints
alter table app.audit_log rename constraint audit_log_action_check to chk_audit_log_action;
alter table app.audit_log rename constraint audit_log_pkey          to pk_audit_log;
-- Value-returning infrastructure functions -> fn_ prefix (bodies self-contained)
alter function app.uuid_generate_v7()  rename to fn_uuid_v7;
alter function app.jwt_claim(text)     rename to fn_jwt_claim;
alter function app.current_user_id()   rename to fn_current_user_id;
alter function app.active_org_id()     rename to fn_active_organization;
-- Trigger function rename (tg_write_audit_log -> tg_write_audit)
alter function app.tg_write_audit_log() rename to tg_write_audit;

-- Re-declare trigger functions whose bodies referenced the renamed helpers.
create or replace function app.tg_set_audit_columns()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, app.fn_current_user_id());
    new.updated_by := new.created_by;
  elsif tg_op = 'UPDATE' then
    new.updated_by := app.fn_current_user_id();
  end if;
  return new;
end; $$;

create or replace function app.tg_write_audit()
returns trigger language plpgsql as $$
declare v_org uuid; v_id uuid; v_old jsonb; v_new jsonb;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_org := coalesce((v_old ->> 'organization_id')::uuid, app.fn_active_organization());
    v_id  := (v_old ->> 'id')::uuid;
  else
    v_new := to_jsonb(new);
    v_org := coalesce((v_new ->> 'organization_id')::uuid, app.fn_active_organization());
    v_id  := (v_new ->> 'id')::uuid;
    if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
  end if;
  insert into app.audit_log (organization_id, actor_id, action, entity_table, entity_id, diff)
  values (v_org, app.fn_current_user_id(), tg_op, tg_table_name, v_id,
          jsonb_strip_nulls(jsonb_build_object('old', v_old, 'new', v_new)));
  return case when tg_op = 'DELETE' then old else new end;
end; $$;


-- =====================================================================
-- SECTION 001 — organizations  (tenant root)
-- =====================================================================
create table public.organizations (
  id          uuid        not null default app.fn_uuid_v7(),
  name        text        not null,
  slug        text        not null,
  status      text        not null default 'trial',
  vertical    text,                                   -- config: grooming/vet/hotel/retail/hybrid (extensible)
  settings    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  constraint pk_organizations primary key (id),
  constraint uq_organizations_slug unique (slug),
  constraint chk_organizations_status check (status in ('trial','active','suspended','deleted'))
);

create trigger trg_organizations_updated_at before update on public.organizations
  for each row execute function app.tg_set_updated_at();
create trigger trg_organizations_audit_cols before insert or update on public.organizations
  for each row execute function app.tg_set_audit_columns();
-- No audit-log trigger: organizations is the tenant root (no organization_id).


-- =====================================================================
-- SECTION 002 — branches
-- =====================================================================
create table public.branches (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  name            text        not null,
  status          text        not null default 'active',
  timezone        text        not null default 'UTC',
  is_default      boolean     not null default false,   -- the virtual/default branch (ADR-001 D6)
  address         jsonb       not null default '{}'::jsonb,
  settings        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_branches primary key (id),
  constraint fk_branches_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint uq_branches_org_id unique (organization_id, id),        -- composite-FK target
  constraint uq_branches_org_name unique (organization_id, name),
  constraint chk_branches_status check (status in ('active','closed'))
);
create index idx_branches_organization on public.branches (organization_id);

create trigger trg_branches_updated_at before update on public.branches
  for each row execute function app.tg_set_updated_at();
create trigger trg_branches_audit_cols before insert or update on public.branches
  for each row execute function app.tg_set_audit_columns();
create trigger trg_branches_audit after insert or update or delete on public.branches
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 003 — users  (GLOBAL identity — no organization_id)
-- =====================================================================
create table public.users (
  id                uuid        not null,                 -- = auth.users.id
  email             text        not null,
  full_name         text,
  is_platform_admin boolean     not null default false,   -- source of truth for the JWT claim
  status            text        not null default 'active',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid,
  deleted_at        timestamptz,
  constraint pk_users primary key (id),
  constraint fk_users_auth foreign key (id)
    references auth.users (id) on delete cascade,
  constraint chk_users_status check (status in ('active','deactivated'))
);
create unique index uidx_users_email_lower on public.users (lower(email));

create trigger trg_users_updated_at before update on public.users
  for each row execute function app.tg_set_updated_at();
create trigger trg_users_audit_cols before insert or update on public.users
  for each row execute function app.tg_set_audit_columns();
-- No audit-log trigger: users is global (no organization_id).


-- =====================================================================
-- SECTION 004 — roles  (per-organization; groups permissions)
-- =====================================================================
create table public.roles (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  name            text        not null,
  description     text,
  is_system       boolean     not null default false,     -- seeded default role (still editable)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_roles primary key (id),
  constraint fk_roles_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint uq_roles_org_name unique (organization_id, name),
  constraint uq_roles_org_id   unique (organization_id, id)          -- composite-FK target
);
create index idx_roles_organization on public.roles (organization_id);

create trigger trg_roles_updated_at before update on public.roles
  for each row execute function app.tg_set_updated_at();
create trigger trg_roles_audit_cols before insert or update on public.roles
  for each row execute function app.tg_set_audit_columns();
create trigger trg_roles_audit after insert or update or delete on public.roles
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 005 — memberships  (User <-> Organization bridge; carries Role)
-- =====================================================================
create table public.memberships (
  id              uuid        not null default app.fn_uuid_v7(),
  user_id         uuid        not null,
  organization_id uuid        not null,
  role_id         uuid        not null,
  status          text        not null default 'invited',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_memberships primary key (id),
  constraint fk_memberships_users foreign key (user_id)
    references public.users (id) on delete cascade,
  constraint fk_memberships_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  -- composite FK: the role MUST belong to the same organization (tenant integrity)
  constraint fk_memberships_roles foreign key (organization_id, role_id)
    references public.roles (organization_id, id),
  constraint uq_memberships_user_org unique (user_id, organization_id),  -- one membership per user per org
  constraint uq_memberships_org_id   unique (organization_id, id),       -- composite-FK target
  constraint chk_memberships_status check (status in ('invited','active','suspended','removed'))
);
create index idx_memberships_user_org     on public.memberships (user_id, organization_id);
create index idx_memberships_organization on public.memberships (organization_id);

create trigger trg_memberships_updated_at before update on public.memberships
  for each row execute function app.tg_set_updated_at();
create trigger trg_memberships_audit_cols before insert or update on public.memberships
  for each row execute function app.tg_set_audit_columns();
create trigger trg_memberships_audit after insert or update or delete on public.memberships
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 006 — permissions  (GLOBAL catalog — no organization_id)
-- =====================================================================
create table public.permissions (
  id          uuid        not null default app.fn_uuid_v7(),
  key         text        not null,                        -- e.g. 'users.manage'
  resource    text        not null,                        -- e.g. 'users'
  action      text        not null,                        -- e.g. 'manage'
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  constraint pk_permissions primary key (id),
  constraint uq_permissions_key unique (key)
);

create trigger trg_permissions_updated_at before update on public.permissions
  for each row execute function app.tg_set_updated_at();
create trigger trg_permissions_audit_cols before insert or update on public.permissions
  for each row execute function app.tg_set_audit_columns();
-- No audit-log trigger: permissions is a global catalog (no organization_id).

-- Seed the cross-cutting, module-agnostic permissions. Module-specific keys
-- (appointments.*, inventory.*, payroll.*, …) are seeded by their own
-- milestone, per the "extend, don't front-load" rule.
insert into public.permissions (key, resource, action, description) values
  ('users.manage',    'users',    'manage', 'Invite, edit, deactivate members'),
  ('roles.manage',    'roles',    'manage', 'Create and edit roles and their permissions'),
  ('branches.manage', 'branches', 'manage', 'Create and edit branches'),
  ('branches.all',    'branches', 'all',    'Access data across all branches in the org'),
  ('settings.manage', 'settings', 'manage', 'Edit organization settings'),
  ('reports.view',    'reports',  'view',   'View reports'),
  ('finance.view',    'finance',  'view',   'View financial data');


-- =====================================================================
-- SECTION 007 — role_permissions  (tenant Role <-> global Permission)
-- =====================================================================
create table public.role_permissions (
  role_id         uuid        not null,
  permission_id   uuid        not null,
  organization_id uuid        not null,                     -- denormalized for RLS + composite FK
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint pk_role_permissions primary key (role_id, permission_id),
  -- composite FK: the role MUST belong to the stated organization
  constraint fk_role_permissions_roles foreign key (organization_id, role_id)
    references public.roles (organization_id, id) on delete cascade,
  constraint fk_role_permissions_permissions foreign key (permission_id)
    references public.permissions (id) on delete cascade
);
create index idx_role_permissions_organization on public.role_permissions (organization_id);
create index idx_role_permissions_permission   on public.role_permissions (permission_id);

create trigger trg_role_permissions_updated_at before update on public.role_permissions
  for each row execute function app.tg_set_updated_at();
create trigger trg_role_permissions_audit_cols before insert or update on public.role_permissions
  for each row execute function app.tg_set_audit_columns();
create trigger trg_role_permissions_audit after insert or update or delete on public.role_permissions
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 008 — membership_branch_access  (Membership <-> Branch)
-- =====================================================================
create table public.membership_branch_access (
  membership_id   uuid        not null,
  branch_id       uuid        not null,
  organization_id uuid        not null,                     -- denormalized for RLS + composite FK
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint pk_membership_branch_access primary key (membership_id, branch_id),
  -- composite FKs: both membership and branch MUST belong to the stated org
  constraint fk_mba_memberships foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id) on delete cascade,
  constraint fk_mba_branches foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete cascade
);
create index idx_mba_organization on public.membership_branch_access (organization_id);
create index idx_mba_branch        on public.membership_branch_access (branch_id);

create trigger trg_mba_updated_at before update on public.membership_branch_access
  for each row execute function app.tg_set_updated_at();
create trigger trg_mba_audit_cols before insert or update on public.membership_branch_access
  for each row execute function app.tg_set_audit_columns();
create trigger trg_mba_audit after insert or update or delete on public.membership_branch_access
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
-- RLS is enabled now so no public table is ever exposed unprotected.
-- With no policies present, all non-owner access is denied. Milestone 8
-- authors the tenant / membership / permission / feature policies.
alter table public.organizations            enable row level security;
alter table public.branches                 enable row level security;
alter table public.users                     enable row level security;
alter table public.roles                     enable row level security;
alter table public.memberships               enable row level security;
alter table public.permissions               enable row level security;
alter table public.role_permissions          enable row level security;
alter table public.membership_branch_access  enable row level security;

-- =====================================================================
-- END 0002_identity_access
-- =====================================================================
