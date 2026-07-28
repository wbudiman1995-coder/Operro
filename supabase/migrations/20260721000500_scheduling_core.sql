-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0005_scheduling_core
-- Milestone        5A — Operations (Scheduling Core)
-- Purpose          The single scheduling primitive for every vertical:
--                  unified Resources + availability, the thin Booking core
--                  with a required start/end time model, typed extension
--                  tables (grooming_jobs, boarding_stays) proving both
--                  point-slot and date-range shapes, recurrence, and the
--                  database-enforced occupancy engine (GiST exclusion) that
--                  makes double-booking impossible.
-- Dependencies     0001 (helpers, btree_gist), 0002 (orgs/branches/members),
--                  0004 (customers/pets/service_catalog).
-- Objects Created  TABLES resources, resource_availability, bookings,
--                  booking_recurrence, booking_resources, grooming_jobs,
--                  boarding_stays.
--                  DOMAIN TRIGGER FNS public.tg_bookres_set_exclusive(),
--                  public.tg_bookings_release_resources().
--                  EXCLUSION ex_booking_resources_no_overlap (GiST).
-- Objects Modified None.
-- Constraints      COMPOSITE FKs throughout (tenant integrity). GiST
--                  exclusion for occupancy (ADR-001 D3). Time check
--                  ends_at > starts_at (ADR-001 D5).
-- Triggers         updated_at + audit-columns + audit-log (tenant) on all;
--                  plus two operations-domain triggers (in public, not app,
--                  per Rule 3).
-- RLS Policies     RLS ENABLED (deny-all). Policies in M8. Module gating
--                  (M8): all -> scheduling.
-- Breaking Changes None.
-- Rollback         DROP TABLE (reverse dep order) + the 2 public trigger fns.
-- Notes            Capacity-1 resources are guarded by the exclusion
-- .                constraint now; capacity>1 (shared daycare rooms) enforce
--                  via a count trigger added when daycare is built. Booking
--                  snapshots commercial data at transaction time (Rule 18).
-- =====================================================================


-- =====================================================================
-- SECTION 001 — resources  (unified schedulable; branch-scoped)
-- =====================================================================
create table public.resources (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  branch_id       uuid        not null,
  kind            text        not null,                     -- staff|room|kennel|van|station|table|... (extensible)
  name            text        not null,
  membership_id   uuid,                                     -- set when the resource IS a staff member
  capacity        integer     not null default 1,
  skills          jsonb       not null default '[]'::jsonb, -- skill keys (staff)
  status          text        not null default 'active',
  settings        jsonb       not null default '{}'::jsonb,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_resources primary key (id),
  constraint fk_resources_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_resources_branches foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete cascade,
  constraint fk_resources_memberships foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id) on delete set null,
  constraint uq_resources_org_id unique (organization_id, id),
  constraint chk_resources_capacity check (capacity >= 1),
  constraint chk_resources_status check (status in ('active','maintenance','retired'))
);
create index idx_resources_org_branch on public.resources (organization_id, branch_id);

create trigger trg_resources_updated_at before update on public.resources
  for each row execute function app.tg_set_updated_at();
create trigger trg_resources_audit_cols before insert or update on public.resources
  for each row execute function app.tg_set_audit_columns();
create trigger trg_resources_audit after insert or update or delete on public.resources
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 002 — resource_availability  (working windows / blackouts)
-- =====================================================================
create table public.resource_availability (
  id              uuid        not null default app.fn_uuid_v7(),
  organization_id uuid        not null,
  branch_id       uuid        not null,
  resource_id     uuid        not null,
  kind            text        not null default 'available', -- available | blackout
  day_of_week     smallint,                                 -- 0-6 for weekly recurring
  start_time      time,
  end_time        time,
  effective_from  date,
  effective_to    date,
  starts_at       timestamptz,                              -- explicit one-off window/blackout
  ends_at         timestamptz,
  notes           text,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  constraint pk_resource_availability primary key (id),
  constraint fk_resource_availability_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_resource_availability_resources foreign key (organization_id, resource_id)
    references public.resources (organization_id, id) on delete cascade,
  constraint chk_resource_availability_kind check (kind in ('available','blackout')),
  constraint chk_resource_availability_dow check (day_of_week is null or day_of_week between 0 and 6)
);
create index idx_resource_availability_org_resource
  on public.resource_availability (organization_id, resource_id);

create trigger trg_resource_availability_updated_at before update on public.resource_availability
  for each row execute function app.tg_set_updated_at();
create trigger trg_resource_availability_audit_cols before insert or update on public.resource_availability
  for each row execute function app.tg_set_audit_columns();
create trigger trg_resource_availability_audit after insert or update or delete on public.resource_availability
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 003 — bookings  (thin core; the single scheduling primitive)
-- =====================================================================
create table public.bookings (
  id                    uuid        not null default app.fn_uuid_v7(),
  organization_id       uuid        not null,
  branch_id             uuid        not null,
  customer_id           uuid        not null,
  pet_id                uuid,                                 -- nullable (e.g. retail/walk-in)
  booking_type          text        not null,                -- grooming|boarding|vet_visit|transport|daycare (selects extension)
  status                text        not null default 'draft',
  fulfillment_mode      text        not null default 'in_store',
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  service_id            uuid,                                 -- optional link to service_catalog
  service_name_snapshot text,                                 -- Rule 18: snapshot at txn time
  price_snapshot        numeric(14,2),
  currency              text,
  notes                 text,
  metadata              jsonb       not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  deleted_at            timestamptz,
  constraint pk_bookings primary key (id),
  constraint fk_bookings_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_bookings_branches foreign key (organization_id, branch_id)
    references public.branches (organization_id, id),
  constraint fk_bookings_customers foreign key (organization_id, customer_id)
    references public.customers (organization_id, id),
  constraint fk_bookings_pets foreign key (organization_id, pet_id)
    references public.pets (organization_id, id),
  constraint fk_bookings_service foreign key (organization_id, service_id)
    references public.service_catalog (organization_id, id),
  constraint uq_bookings_org_id unique (organization_id, id),
  constraint chk_bookings_status
    check (status in ('draft','requested','confirmed','in_progress','completed','canceled','no_show')),
  constraint chk_bookings_fulfillment
    check (fulfillment_mode in ('in_store','home','pickup_delivery')),
  constraint chk_bookings_time check (ends_at > starts_at)
);
create index idx_bookings_org_branch_starts on public.bookings (organization_id, branch_id, starts_at);
create index idx_bookings_org_customer on public.bookings (organization_id, customer_id);
create index idx_bookings_org_status on public.bookings (organization_id, status);

create trigger trg_bookings_updated_at before update on public.bookings
  for each row execute function app.tg_set_updated_at();
create trigger trg_bookings_audit_cols before insert or update on public.bookings
  for each row execute function app.tg_set_audit_columns();
create trigger trg_bookings_audit after insert or update or delete on public.bookings
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 004 — booking_recurrence  (RRULE; materialized by a job later)
-- =====================================================================
create table public.booking_recurrence (
  id                  uuid        not null default app.fn_uuid_v7(),
  organization_id     uuid        not null,
  template_booking_id uuid        not null,                   -- defines service/customer/pet/time template
  rrule               text        not null,                   -- RFC 5545 recurrence rule
  until               timestamptz,
  max_count           integer,
  is_active           boolean     not null default true,
  metadata            jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  deleted_at          timestamptz,
  constraint pk_booking_recurrence primary key (id),
  constraint fk_booking_recurrence_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_booking_recurrence_bookings foreign key (organization_id, template_booking_id)
    references public.bookings (organization_id, id) on delete cascade
);
create index idx_booking_recurrence_org on public.booking_recurrence (organization_id);

create trigger trg_booking_recurrence_updated_at before update on public.booking_recurrence
  for each row execute function app.tg_set_updated_at();
create trigger trg_booking_recurrence_audit_cols before insert or update on public.booking_recurrence
  for each row execute function app.tg_set_audit_columns();
create trigger trg_booking_recurrence_audit after insert or update or delete on public.booking_recurrence
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 005 — Operations-domain trigger functions  (public, not app)
-- =====================================================================
-- Stamp exclusivity from the resource's capacity so the partial exclusion
-- constraint guards only capacity-1 resources.
create or replace function public.tg_bookres_set_exclusive()
returns trigger language plpgsql as $$
begin
  select (r.capacity = 1) into new.is_exclusive
  from public.resources r
  where r.id = new.resource_id and r.organization_id = new.organization_id;
  if new.is_exclusive is null then new.is_exclusive := true; end if;
  return new;
end; $$;

-- Release / re-hold resource occupancy when a booking's status changes.
create or replace function public.tg_bookings_release_resources()
returns trigger language plpgsql as $$
begin
  if new.status in ('canceled','no_show') and old.status not in ('canceled','no_show') then
    update public.booking_resources set is_active = false
     where booking_id = new.id and organization_id = new.organization_id;
  elsif old.status in ('canceled','no_show') and new.status not in ('canceled','no_show') then
    update public.booking_resources set is_active = true
     where booking_id = new.id and organization_id = new.organization_id;  -- may raise exclusion if slot re-taken
  end if;
  return new;
end; $$;


-- =====================================================================
-- SECTION 006 — booking_resources  (assignment + OCCUPANCY ENGINE)
-- =====================================================================
create table public.booking_resources (
  booking_id      uuid        not null,
  resource_id     uuid        not null,
  organization_id uuid        not null,
  during          tstzrange   not null,                      -- occupied window [starts_at, ends_at)
  is_exclusive    boolean     not null default true,         -- stamped from resource.capacity
  is_active       boolean     not null default true,         -- false when booking canceled/no_show
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint pk_booking_resources primary key (booking_id, resource_id),
  constraint fk_booking_resources_bookings foreign key (organization_id, booking_id)
    references public.bookings (organization_id, id) on delete cascade,
  constraint fk_booking_resources_resources foreign key (organization_id, resource_id)
    references public.resources (organization_id, id),
  -- OCCUPANCY: no two active, exclusive assignments of the same resource may overlap.
  constraint ex_booking_resources_no_overlap
    exclude using gist (organization_id with =, resource_id with =, during with &&)
    where (is_active and is_exclusive)
);
create index idx_booking_resources_org_resource on public.booking_resources (organization_id, resource_id);

create trigger trg_booking_resources_set_exclusive before insert or update on public.booking_resources
  for each row execute function public.tg_bookres_set_exclusive();
create trigger trg_booking_resources_updated_at before update on public.booking_resources
  for each row execute function app.tg_set_updated_at();
create trigger trg_booking_resources_audit_cols before insert or update on public.booking_resources
  for each row execute function app.tg_set_audit_columns();
create trigger trg_booking_resources_audit after insert or update or delete on public.booking_resources
  for each row execute function app.tg_write_audit();

-- Attach the status->occupancy sync trigger to bookings (defined in SECTION 005).
create trigger trg_bookings_release_resources after update of status on public.bookings
  for each row execute function public.tg_bookings_release_resources();


-- =====================================================================
-- SECTION 007 — Typed extensions (thin core + typed detail; ADR-001)
-- =====================================================================
-- Grooming job — point-slot shape.
create table public.grooming_jobs (
  booking_id      uuid        not null,
  organization_id uuid        not null,
  checklist       jsonb       not null default '{}'::jsonb,  -- SOP checklist state
  photos          jsonb       not null default '[]'::jsonb,  -- captured required photos
  groomer_notes   text,
  coat_condition  text,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint pk_grooming_jobs primary key (booking_id),
  constraint fk_grooming_jobs_bookings foreign key (organization_id, booking_id)
    references public.bookings (organization_id, id) on delete cascade
);
create trigger trg_grooming_jobs_updated_at before update on public.grooming_jobs
  for each row execute function app.tg_set_updated_at();
create trigger trg_grooming_jobs_audit_cols before insert or update on public.grooming_jobs
  for each row execute function app.tg_set_audit_columns();
create trigger trg_grooming_jobs_audit after insert or update or delete on public.grooming_jobs
  for each row execute function app.tg_write_audit();

-- Boarding stay — date-range shape (same booking time model, different detail).
create table public.boarding_stays (
  booking_id       uuid        not null,
  organization_id  uuid        not null,
  check_in_at      timestamptz,                               -- actuals vs. scheduled booking window
  check_out_at     timestamptz,
  feeding_schedule jsonb       not null default '{}'::jsonb,
  belongings       text,
  metadata         jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid,
  constraint pk_boarding_stays primary key (booking_id),
  constraint fk_boarding_stays_bookings foreign key (organization_id, booking_id)
    references public.bookings (organization_id, id) on delete cascade
);
create trigger trg_boarding_stays_updated_at before update on public.boarding_stays
  for each row execute function app.tg_set_updated_at();
create trigger trg_boarding_stays_audit_cols before insert or update on public.boarding_stays
  for each row execute function app.tg_set_audit_columns();
create trigger trg_boarding_stays_audit after insert or update or delete on public.boarding_stays
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 099 — Row Level Security (safety default: ENABLE, deny-all)
-- =====================================================================
alter table public.resources             enable row level security;
alter table public.resource_availability enable row level security;
alter table public.bookings              enable row level security;
alter table public.booking_recurrence    enable row level security;
alter table public.booking_resources     enable row level security;
alter table public.grooming_jobs         enable row level security;
alter table public.boarding_stays        enable row level security;

-- =====================================================================
-- END 0005_scheduling_core
-- =====================================================================
