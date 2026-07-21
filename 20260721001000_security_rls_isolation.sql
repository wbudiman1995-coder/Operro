-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0006_inventory_tasks
-- Milestone        5B — Operations (Inventory + Tasks / SOP)
-- Purpose          Accounting-grade inventory: an append-only movement
--                  ledger as the source of truth, a trigger-maintained
--                  balance cache derivable from it, service-consumption
--                  recipes with automatic consumption on booking completion,
--                  plus lightweight SOP templates and operational tasks.
-- Dependencies     0001 (helpers), 0002 (branches/memberships), 0004
--                  (product_catalog/service_catalog), 0005 (bookings).
-- Objects Created  app.tg_block_update() (generic immutability guard)
--                  TABLES inventory_movements, inventory_levels,
--                  service_products, sop_templates, tasks
--                  FNS public.fn_inventory_derive_level(...),
--                      public.tg_inventory_apply_movement(),
--                      public.fn_consume_service_inventory(uuid,uuid),
--                      public.tg_bookings_consume_on_complete()
-- Constraints      COMPOSITE FKs; signed-quantity ledger; movement-type chk.
-- Triggers         inventory_movements: append-only (block update+delete),
--                  audit-columns, level-apply. Others: standard.
-- RLS Policies     RLS ENABLED (deny-all). Policies in M8. Module gating
--                  (M8): inventory -> inventory; tasks/sop -> scheduling.
-- Breaking Changes None. app.tg_block_update() is additive foundation infra.
-- Rollback         DROP the 5 tables + 4 public fns + app.tg_block_update.
-- Notes            Ledger rows are IMMUTABLE (no updated_at/deleted_at).
--                  Current stock is always derivable from movements; the
--                  levels cache is maintained in the same transaction and is
--                  reconcilable via fn_inventory_derive_level.
-- =====================================================================


-- =====================================================================
-- SECTION 000 — Additive foundation infra: generic update guard
-- =====================================================================
create or replace function app.tg_block_update()
returns trigger language plpgsql as $$
begin
  raise exception 'Updates blocked on % (append-only/immutable). Insert a correcting row instead.',
    tg_table_name using errcode = 'restrict_violation';
  return null;
end; $$;

-- Stamp created_by only. For immutable/append-only tables that (by design)
-- have no updated_by column, so tg_set_audit_columns does not apply.
create or replace function app.tg_set_created_by()
returns trigger language plpgsql as $$
begin
  new.created_by := coalesce(new.created_by, app.fn_current_user_id());
  return new;
end; $$;


-- =====================================================================
-- SECTION 001 — inventory_movements  (append-only LEDGER = source of truth)
-- =====================================================================
create table public.inventory_movements (
  id                   uuid        not null default app.fn_uuid_v7(),
  organization_id      uuid        not null,
  branch_id            uuid        not null,
  product_id           uuid        not null,
  movement_type        text        not null,               -- see chk below
  quantity             numeric(14,3) not null,              -- SIGNED: + increases, - decreases
  unit_cost            numeric(14,2),
  reference_booking_id uuid,                                 -- set for 'consumption'
  transfer_group_id    uuid,                                 -- pairs transfer_out/transfer_in
  notes                text,
  metadata             jsonb       not null default '{}'::jsonb,
  occurred_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  created_by           uuid,                                 -- immutable ledger: no updated_at/by, no deleted_at
  constraint pk_inventory_movements primary key (id),
  constraint fk_inventory_movements_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_inventory_movements_branches foreign key (organization_id, branch_id)
    references public.branches (organization_id, id),
  constraint fk_inventory_movements_products foreign key (organization_id, product_id)
    references public.product_catalog (organization_id, id),
  constraint fk_inventory_movements_booking foreign key (organization_id, reference_booking_id)
    references public.bookings (organization_id, id),
  constraint chk_inventory_movements_type check (movement_type in
    ('opening_balance','purchase','adjustment','consumption','transfer_in','transfer_out','damaged','expired')),
  constraint chk_inventory_movements_qty_nonzero check (quantity <> 0)
);
create index idx_inventory_movements_org_branch_product
  on public.inventory_movements (organization_id, branch_id, product_id, occurred_at);
create index idx_inventory_movements_booking
  on public.inventory_movements (organization_id, reference_booking_id);

create trigger trg_inventory_movements_created_by before insert on public.inventory_movements
  for each row execute function app.tg_set_created_by();
create trigger trg_inventory_movements_block_update before update on public.inventory_movements
  for each row execute function app.tg_block_update();
create trigger trg_inventory_movements_block_delete before delete on public.inventory_movements
  for each row execute function app.tg_block_hard_delete();


-- =====================================================================
-- SECTION 002 — inventory_levels  (derived CACHE; truth stays in ledger)
-- =====================================================================
create table public.inventory_levels (
  organization_id uuid          not null,
  branch_id       uuid          not null,
  product_id      uuid          not null,
  quantity        numeric(14,3) not null default 0,
  updated_at      timestamptz   not null default now(),
  constraint pk_inventory_levels primary key (organization_id, branch_id, product_id),
  constraint fk_inventory_levels_branches foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete cascade,
  constraint fk_inventory_levels_products foreign key (organization_id, product_id)
    references public.product_catalog (organization_id, id) on delete cascade
);

-- Recompute a level straight from the ledger (reconciliation / source of truth).
create or replace function public.fn_inventory_derive_level(p_org uuid, p_branch uuid, p_product uuid)
returns numeric language sql stable as $$
  select coalesce(sum(quantity), 0)
  from public.inventory_movements
  where organization_id = p_org and branch_id = p_branch and product_id = p_product;
$$;

-- Apply each ledger insert to the cache, in the SAME transaction (no drift).
create or replace function public.tg_inventory_apply_movement()
returns trigger language plpgsql as $$
begin
  insert into public.inventory_levels (organization_id, branch_id, product_id, quantity, updated_at)
  values (new.organization_id, new.branch_id, new.product_id, new.quantity, now())
  on conflict (organization_id, branch_id, product_id)
  do update set quantity = public.inventory_levels.quantity + excluded.quantity,
                updated_at = now();
  return new;
end; $$;

create trigger trg_inventory_movements_apply_level after insert on public.inventory_movements
  for each row execute function public.tg_inventory_apply_movement();


-- =====================================================================
-- SECTION 003 — service_products  (consumption recipe)
-- =====================================================================
create table public.service_products (
  service_id      uuid          not null,
  product_id      uuid          not null,
  organization_id uuid          not null,
  quantity        numeric(14,3) not null,                    -- consumed per service execution
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint pk_service_products primary key (service_id, product_id),
  constraint fk_service_products_services foreign key (organization_id, service_id)
    references public.service_catalog (organization_id, id) on delete cascade,
  constraint fk_service_products_products foreign key (organization_id, product_id)
    references public.product_catalog (organization_id, id) on delete cascade,
  constraint chk_service_products_qty check (quantity > 0)
);
create index idx_service_products_org on public.service_products (organization_id);

create trigger trg_service_products_updated_at before update on public.service_products
  for each row execute function app.tg_set_updated_at();
create trigger trg_service_products_audit_cols before insert or update on public.service_products
  for each row execute function app.tg_set_audit_columns();
create trigger trg_service_products_audit after insert or update or delete on public.service_products
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 004 — Automatic consumption on booking completion
-- =====================================================================
-- Idempotent: writes consumption movements for a completed booking's service
-- recipe, once. Negative stock is allowed (records reality; low-stock alerts
-- are a separate feature).
create or replace function public.fn_consume_service_inventory(p_booking uuid, p_org uuid)
returns void language plpgsql as $$
declare v_branch uuid; v_service uuid;
begin
  -- guard: already consumed?
  if exists (select 1 from public.inventory_movements
             where organization_id = p_org and reference_booking_id = p_booking
               and movement_type = 'consumption') then
    return;
  end if;
  select branch_id, service_id into v_branch, v_service
  from public.bookings where id = p_booking and organization_id = p_org;
  if v_service is null then return; end if;

  insert into public.inventory_movements
    (organization_id, branch_id, product_id, movement_type, quantity, reference_booking_id, notes)
  select p_org, v_branch, sp.product_id, 'consumption', -sp.quantity, p_booking, 'auto: service completion'
  from public.service_products sp
  where sp.organization_id = p_org and sp.service_id = v_service;
end; $$;

create or replace function public.tg_bookings_consume_on_complete()
returns trigger language plpgsql as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform public.fn_consume_service_inventory(new.id, new.organization_id);
  end if;
  return new;
end; $$;

create trigger trg_bookings_consume_on_complete after update of status on public.bookings
  for each row execute function public.tg_bookings_consume_on_complete();


-- =====================================================================
-- SECTION 005 — sop_templates  (lightweight; taps/photos/checkboxes)
-- =====================================================================
create table public.sop_templates (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  name            text        not null,
  service_id      uuid,                                       -- optional link to a service
  steps           jsonb       not null default '[]'::jsonb,   -- [{label, requires_photo, required}]
  is_active       boolean     not null default true,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_sop_templates primary key (id),
  constraint fk_sop_templates_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_sop_templates_services foreign key (organization_id, service_id)
    references public.service_catalog (organization_id, id) on delete set null,
  constraint uq_sop_templates_org_name unique (organization_id, name)
);
create index idx_sop_templates_org on public.sop_templates (organization_id);

create trigger trg_sop_templates_updated_at before update on public.sop_templates
  for each row execute function app.tg_set_updated_at();
create trigger trg_sop_templates_audit_cols before insert or update on public.sop_templates
  for each row execute function app.tg_set_audit_columns();
create trigger trg_sop_templates_audit after insert or update or delete on public.sop_templates
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 006 — tasks  (lightweight operational checklists)
-- =====================================================================
create table public.tasks (
  id                    uuid        not null default app.fn_uuid_v7(),
  organization_id       uuid        not null,
  branch_id             uuid        not null,
  booking_id            uuid,                                 -- optional link
  assigned_membership_id uuid,
  title                 text        not null,
  status                text        not null default 'todo',
  priority              text        not null default 'normal',
  due_at                timestamptz,
  checklist             jsonb       not null default '[]'::jsonb,
  metadata              jsonb       not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  deleted_at            timestamptz,
  constraint pk_tasks primary key (id),
  constraint fk_tasks_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_tasks_branches foreign key (organization_id, branch_id)
    references public.branches (organization_id, id),
  constraint fk_tasks_bookings foreign key (organization_id, booking_id)
    references public.bookings (organization_id, id) on delete set null,
  constraint fk_tasks_memberships foreign key (organization_id, assigned_membership_id)
    references public.memberships (organization_id, id) on delete set null,
  constraint chk_tasks_status check (status in ('todo','in_progress','done','canceled')),
  constraint chk_tasks_priority check (priority in ('low','normal','high','urgent'))
);
create index idx_tasks_org_branch_status on public.tasks (organization_id, branch_id, status);

create trigger trg_tasks_updated_at before update on public.tasks
  for each row execute function app.tg_set_updated_at();
create trigger trg_tasks_audit_cols before insert or update on public.tasks
  for each row execute function app.tg_set_audit_columns();
create trigger trg_tasks_audit after insert or update or delete on public.tasks
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
alter table public.inventory_movements enable row level security;
alter table public.inventory_levels    enable row level security;
alter table public.service_products    enable row level security;
alter table public.sop_templates       enable row level security;
alter table public.tasks                enable row level security;

-- =====================================================================
-- END 0006_inventory_tasks
-- =====================================================================
