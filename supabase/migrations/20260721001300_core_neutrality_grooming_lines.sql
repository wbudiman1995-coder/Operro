-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0013_core_neutrality_grooming_lines
-- Milestone        Increment 1 — Batch 1 (FINAL SECURITY & INTEGRITY PASS)
-- Purpose          Core neutrality + grooming multi-pet/multi-service +
--                  package-reservation lifecycle + a single SECURITY DEFINER
--                  CompleteBooking RPC.
--                  FINAL-PASS corrections over pass-3 (database-ENFORCED, tested
--                  live in 0013_test_security_final.sql):
--                  (F1) authenticated has NO direct INSERT/DELETE on
--                       grooming_job_pets / grooming_job_pet_services /
--                       package_reservations, and NO table-level UPDATE on the
--                       line tables — only SELECT + a narrow safe-column UPDATE
--                       (SECTION 720). Authoritative/identity/commercial columns
--                       are not client-writable. This EXPLICITLY EXCLUDES
--                       grooming_job_pet_services.quantity (drives commission
--                       basis + inventory consumption) and BOTH tables'
--                       deleted_at (direct soft-delete would remove a required
--                       record from completion/commission/inventory/package
--                       effects — revoking SQL DELETE alone was insufficient).
--                       "RPC-controlled" is now backed by actual privileges,
--                       proven by TCREATE*/TDEL*/TPROT*/TQTY*/TSOFTDEL*.
--                  (F2) BRANCH ISOLATION on all grooming paths (SECTION 705 +
--                       app.tenant_has_branch): a user restricted to one branch
--                       cannot read/update/reserve against another branch's
--                       records; reserve_package_session loads the booking
--                       branch and passes it to assert_tenant_authorized.
--                  (F3) transition_booking_status RELEASES active package
--                       reservations on canceled/no_show (restores availability,
--                       idempotent, never consumes a session silently).
--                  (F4) booking commercial caches (service_name_snapshot,
--                       price_snapshot, currency) removed from authenticated
--                       INSERT and UPDATE grants — clients cannot create a
--                       cache-vs-line mismatch (SECTION 610).
--                  (F5) strict concurrency harness: session B is a genuinely
--                       failing process (nonzero exit, exactly one expected
--                       error, no other ERROR lines); A_RC and B_RC both checked.
--                  Pass-3 corrections over pass-2:
--                  (12) WHOLE FILE now runs as ONE explicit transaction
--                       (BEGIN;...COMMIT;) — psql's default is per-statement
--                       autocommit, so pass-2, despite SECTION 310's abort
--                       block, was NOT actually atomic: an abort there rolled
--                       back only the DO block itself, leaving SECTIONS
--                       100-300's tables/backfill already committed. Fixed by
--                       wrapping the file; no internal exception handler, no
--                       explicit ROLLBACK — an unhandled RAISE EXCEPTION now
--                       aborts the whole transaction and psql/ON_ERROR_STOP
--                       exits nonzero, per the negative harness in
--                       0013_negative_backfill/.
--                  (13) SECTION 310 now ALSO aborts if any NON-grooming
--                       booking still has pet_id/service_id populated (the
--                       backfill in SECTION 300 only maps booking_type=
--                       'grooming' rows; SECTION 320 previously dropped both
--                       columns unconditionally, which would have silently
--                       discarded any such non-grooming legacy data).
--                  (14) DELETE revoked from authenticated on grooming_job_pets
--                       and grooming_job_pet_services (soft-delete via
--                       deleted_at is the only client path); package_reservations
--                       FK from CASCADE to RESTRICT so a line with reservation
--                       history can never be silently deleted, preserving the
--                       audit trail even for the table owner.
--                  (15) Explicit `revoke ... from public` added for every
--                       client-facing RPC and boolean helper (Postgres grants
--                       EXECUTE to PUBLIC by default on CREATE FUNCTION;
--                       pass-2 only ever GRANTed to `authenticated` and never
--                       stripped the default PUBLIC grant, so the 4 public
--                       RPCs and 3 tenant_has_* helpers were reachable by ANY
--                       role, not just authenticated, until now).
-- Pass-2 corrections over pass-1 (retained):
--                  (1) all fixture UUIDs are valid 8-4-4-4-12 hex (script-checked);
--                  (2) grooming_jobs composite-FK target;
--                  (3) tenant-only authz guard + full package validation;
--                  (4) availability RPC takes only package id (derives org);
--                  (5) NO platform-admin bypass on any new-table path — new
--                      tenant_has_* helpers used in policies + RPC guard;
--                  (6) package_reservations has no client DML; protected line
--                      fields not client-updatable;
--                  (7) effects fire ONLY for 'complete' pets; skipped-line
--                      reservations released; optional pending pets block;
--                  (8) generic app.transition_booking_status state machine;
--                  (9) app.expire_package_reservations frees stale holds;
--                  (10) NO privileged repair escape hatch (deferred to 0014);
--                  (11) commission source identity frozen (line/booking/invoice).
-- Dependencies     0001-0012.
-- Ordering         SECTION 100 add tables/constraints -> 200 grooming_jobs
--                  composite-FK target -> 300 backfill -> 310 validate+abort
--                  -> 320 DROP legacy columns -> 400+ functions/policies.
-- Enforcement      Completion is privilege-based: authenticated has NO direct
--                  UPDATE(status) privilege on bookings; only app.complete_booking
--                  (SECURITY DEFINER, owned by a non-login role) may set
--                  status='completed'. No client-settable GUC is trusted. See
--                  SECTION 610 for the documented mechanism.
-- Idempotency      Permanent per-line effect identity via unique constraints on
--                  reference_line_id (commission), (reference_line_id,product_id)
--                  (inventory consumption), and one reservation lifecycle per
--                  line keyed on grooming_job_pet_service_id across the WHOLE
--                  table (not a status-partial index). Reversal writes a
--                  compensating ledger row and never frees the line for reuse.
-- RLS Policies     New tables get permissive org+membership isolation (0010
--                  pattern) AND restrictive module/read/create/update/delete
--                  capability policies (0011 pattern). Business-controlled
--                  fields are written through RPCs, not free client writes.
-- Breaking Changes bookings.pet_id / service_id removed AFTER backfill.
--                  Completion requires app.complete_booking(); direct
--                  status='completed' is revoked at the privilege layer.
-- Rollback         SECTION 900. Column drops are destructive; a true rollback
--                  needs the BACKFILL_REPORT data plan.
-- Evidence         EXECUTED against PostgreSQL 16.14. Migrations 0001-0012
--                  applied to build a baseline; this migration then applied
--                  clean, and the full suite run to green via the clean-room
--                  runner (run_clean_room.sh). See TEST_EXECUTION_LOG.md for
--                  version, timestamp, commands, checksums, and pass counts.
--                  Companions: 0013_test_core_neutrality.sql,
--                  0013_test_security_final.sql, 0013_effects_eligibility_
--                  scenario.sql, run_concurrency.sh, 0013_backfill_harness/.
-- =====================================================================

-- =====================================================================
-- PASS-3 ATOMICITY WRAPPER (REVIEW ITEM 12)
-- ---------------------------------------------------------------------
-- psql runs each top-level statement as its own autocommit transaction
-- UNLESS an explicit BEGIN is open. Wrapping the whole file makes SECTIONS
-- 000-900 one atomic unit: if ANY statement fails (including the SECTION 310
-- BACKFILL ABORT raise), Postgres aborts the transaction and NOTHING commits
-- — no tables created, no backfill rows, no column drops, no grants. There is
-- deliberately NO exception handler here and NO explicit ROLLBACK: an
-- unhandled error inside a transaction block leaves Postgres holding the
-- transaction open-but-aborted, and the following COMMIT is then itself
-- rejected by the server ("current transaction is aborted"), so psql (run
-- with -v ON_ERROR_STOP=1) exits nonzero and the failure is unambiguous to
-- the calling shell harness. See 0013_negative_backfill/ for the executed
-- proof of this behavior.
-- =====================================================================
begin;


-- =====================================================================
-- SECTION 000 — Drop superseded status-triggered completion effects
-- =====================================================================
drop trigger if exists trg_bookings_accrue_commission   on public.bookings;
drop trigger if exists trg_bookings_consume_on_complete on public.bookings;
drop trigger if exists trg_bookings_consume_package     on public.bookings;
drop function if exists public.tg_bookings_accrue_commission();
drop function if exists public.tg_bookings_consume_on_complete();
drop function if exists public.tg_bookings_consume_package();
drop function if exists public.fn_accrue_commission(uuid, uuid);
drop function if exists public.fn_consume_service_inventory(uuid, uuid);
drop function if exists public.fn_consume_package_session(uuid, uuid);


-- =====================================================================
-- SECTION 200 — grooming_jobs composite-FK target (REVIEW ITEM 2)
-- ---------------------------------------------------------------------
-- grooming_jobs PK is (booking_id) only. To reference it with the composite
-- tenant-integrity pattern (organization_id, grooming_job_id), it needs a
-- matching unique key on (organization_id, booking_id). Added before any
-- child table references it.
-- =====================================================================
alter table public.grooming_jobs
  add constraint uq_grooming_jobs_org_id unique (organization_id, booking_id);


-- =====================================================================
-- SECTION 100 — New tables (added BEFORE backfill, BEFORE any drop)
-- =====================================================================

-- ---- grooming_job_pets --------------------------------------------------
create table public.grooming_job_pets (
  id                   uuid        not null default app.fn_uuid_v7(),
  organization_id      uuid        not null,
  grooming_job_id      uuid        not null,          -- = grooming_jobs.booking_id
  pet_id               uuid        not null,
  sequence             integer     not null default 1,
  assigned_resource_id uuid,
  status               text        not null default 'pending',  -- pending|in_progress|complete|skipped
  is_required          boolean     not null default true,
  instructions         text,
  warnings             text,
  preferences          jsonb       not null default '{}'::jsonb,
  evidence_required    jsonb       not null default '{}'::jsonb,
  metadata             jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  deleted_at           timestamptz,
  constraint pk_grooming_job_pets primary key (id),
  constraint fk_gjp_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_gjp_grooming_jobs foreign key (organization_id, grooming_job_id)
    references public.grooming_jobs (organization_id, booking_id) on delete cascade,
  constraint fk_gjp_pets foreign key (organization_id, pet_id)
    references public.pets (organization_id, id),
  constraint fk_gjp_resource foreign key (organization_id, assigned_resource_id)
    references public.resources (organization_id, id),
  constraint uq_gjp_org_id unique (organization_id, id),
  constraint uq_gjp_job_pet unique (organization_id, grooming_job_id, pet_id),
  constraint chk_gjp_status check (status in ('pending','in_progress','complete','skipped')),
  constraint chk_gjp_sequence check (sequence > 0)
);
create index idx_gjp_org_job on public.grooming_job_pets (organization_id, grooming_job_id, sequence);
create index idx_gjp_org_pet on public.grooming_job_pets (organization_id, pet_id);
create trigger trg_gjp_updated_at before update on public.grooming_job_pets
  for each row execute function app.tg_set_updated_at();
create trigger trg_gjp_audit_cols before insert or update on public.grooming_job_pets
  for each row execute function app.tg_set_audit_columns();
create trigger trg_gjp_audit after insert or update or delete on public.grooming_job_pets
  for each row execute function app.tg_write_audit();

-- ---- grooming_job_pet_services (authoritative commercial line) -----------
create table public.grooming_job_pet_services (
  id                    uuid          not null default app.fn_uuid_v7(),
  organization_id       uuid          not null,
  grooming_job_pet_id   uuid          not null,
  service_id            uuid          not null,
  service_name_snapshot text          not null,
  duration_minutes      integer       not null default 60,
  quantity              integer       not null default 1,
  unit_price_snapshot   numeric(14,2) not null default 0,
  currency              text          not null default 'USD',
  assigned_resource_id  uuid,
  commission_basis      numeric(14,2),
  inventory_basis       text          not null default 'recipe',  -- recipe|none
  instructions          text,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz    not null default now(),
  updated_at            timestamptz    not null default now(),
  created_by            uuid,
  updated_by            uuid,
  deleted_at            timestamptz,
  -- NOTE (REVIEW ITEM 6): no package_reservation_id here. The authoritative
  -- link is package_reservations.grooming_job_pet_service_id (one direction).
  constraint pk_gjps primary key (id),
  constraint fk_gjps_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_gjps_job_pet foreign key (organization_id, grooming_job_pet_id)
    references public.grooming_job_pets (organization_id, id) on delete cascade,
  constraint fk_gjps_service foreign key (organization_id, service_id)
    references public.service_catalog (organization_id, id),
  constraint fk_gjps_resource foreign key (organization_id, assigned_resource_id)
    references public.resources (organization_id, id),
  constraint uq_gjps_org_id unique (organization_id, id),
  constraint chk_gjps_quantity check (quantity > 0),
  constraint chk_gjps_duration check (duration_minutes > 0),
  constraint chk_gjps_unit_price check (unit_price_snapshot >= 0),
  constraint chk_gjps_inventory_basis check (inventory_basis in ('recipe','none'))
);
create index idx_gjps_org_jobpet on public.grooming_job_pet_services (organization_id, grooming_job_pet_id);
create index idx_gjps_org_service on public.grooming_job_pet_services (organization_id, service_id);
create trigger trg_gjps_updated_at before update on public.grooming_job_pet_services
  for each row execute function app.tg_set_updated_at();
create trigger trg_gjps_audit_cols before insert or update on public.grooming_job_pet_services
  for each row execute function app.tg_set_audit_columns();
create trigger trg_gjps_audit after insert or update or delete on public.grooming_job_pet_services
  for each row execute function app.tg_write_audit();

-- ---- package_reservations ----------------------------------------------
create table public.package_reservations (
  id                          uuid        not null default app.fn_uuid_v7(),
  organization_id             uuid        not null,
  customer_package_id         uuid        not null,
  grooming_job_pet_service_id uuid        not null,   -- authoritative link (REVIEW ITEM 6)
  status                      text        not null default 'reserved', -- reserved|consumed|released|expired
  reserved_at                 timestamptz not null default now(),
  consumed_at                 timestamptz,
  released_at                 timestamptz,
  expires_at                  timestamptz,
  consumption_ledger_id       uuid,
  reversal_ledger_id          uuid,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid,
  updated_by                  uuid,
  constraint pk_package_reservations primary key (id),
  constraint fk_pr_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_pr_customer_packages foreign key (organization_id, customer_package_id)
    references public.customer_packages (organization_id, id) on delete cascade,
  -- REVIEW ITEM 14 (pass 3): RESTRICT, not CASCADE. A line that has ANY
  -- reservation history (reserved/consumed/released/expired) can never be
  -- silently deleted out from under its reservation — deletion is blocked
  -- until the reservation is explicitly released/expired, preserving the
  -- audit trail described in app.expire_package_reservations's comments.
  constraint fk_pr_line foreign key (organization_id, grooming_job_pet_service_id)
    references public.grooming_job_pet_services (organization_id, id) on delete restrict,
  constraint uq_pr_org_id unique (organization_id, id),
  constraint chk_pr_status check (status in ('reserved','consumed','released','expired'))
);
create index idx_pr_org_package on public.package_reservations (organization_id, customer_package_id, status);
create index idx_pr_org_line on public.package_reservations (organization_id, grooming_job_pet_service_id);

-- REVIEW ITEM 7: ONE reservation lifecycle per service line, enforced across
-- the WHOLE table (not a status-partial index that vanishes after transition).
-- A line may have at most one reservation row ever; reversal marks it released
-- and re-consumption requires a NEW corrected line, never reuse of this one.
create unique index uidx_pr_one_lifecycle_per_line
  on public.package_reservations (organization_id, grooming_job_pet_service_id);

create trigger trg_pr_updated_at before update on public.package_reservations
  for each row execute function app.tg_set_updated_at();
create trigger trg_pr_audit_cols before insert or update on public.package_reservations
  for each row execute function app.tg_set_audit_columns();
create trigger trg_pr_audit after insert or update or delete on public.package_reservations
  for each row execute function app.tg_write_audit();


-- =====================================================================
-- SECTION 110 — Per-line effect identity columns on the ledgers
-- ---------------------------------------------------------------------
-- REVIEW ITEM 7: permanent, database-enforced per-line effect identity.
-- =====================================================================
alter table public.commission_entries
  add column if not exists reference_line_id uuid;
alter table public.commission_entries
  add constraint fk_commission_entries_line
  foreign key (organization_id, reference_line_id)
  references public.grooming_job_pet_services (organization_id, id);
-- Exactly one commission accrual per line, permanently.
create unique index uidx_commission_entries_line
  on public.commission_entries (organization_id, reference_line_id)
  where reference_line_id is not null;

-- REVIEW ITEM 11: freeze the commission source identity. The 0009 freeze trigger
-- covered monetary fields + membership; extend it so reference_line_id,
-- reference_booking_id, reference_invoice_id can never change after insert
-- either. Redefined here (after reference_line_id exists).
create or replace function public.tg_commission_entries_freeze()
returns trigger language plpgsql as $$
begin
  if (new.base_amount, new.commission_amount, new.rate_snapshot, new.membership_id,
      new.currency, new.reference_line_id, new.reference_booking_id, new.reference_invoice_id)
     is distinct from
     (old.base_amount, old.commission_amount, old.rate_snapshot, old.membership_id,
      old.currency, old.reference_line_id, old.reference_booking_id, old.reference_invoice_id)
  then
    raise exception 'Commission entry source/identity is immutable except status.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;
-- trigger trg_commission_entries_freeze already attached in 0009; the function
-- body is replaced above (create or replace), so no re-attach needed.

alter table public.inventory_movements
  add column if not exists reference_line_id uuid;
alter table public.inventory_movements
  add constraint fk_inventory_movements_line
  foreign key (organization_id, reference_line_id)
  references public.grooming_job_pet_services (organization_id, id);
-- Exactly one consumption movement per (line, product), permanently.
create unique index uidx_inventory_consumption_line_product
  on public.inventory_movements (organization_id, reference_line_id, product_id)
  where movement_type = 'consumption' and reference_line_id is not null;

alter table public.customer_package_ledger
  add column if not exists reference_line_id uuid;
alter table public.customer_package_ledger
  add constraint fk_cpl_line
  foreign key (organization_id, reference_line_id)
  references public.grooming_job_pet_services (organization_id, id);
-- Exactly one consumption ledger row per line (reversal uses reason<>'consumption').
create unique index uidx_cpl_consumption_per_line
  on public.customer_package_ledger (organization_id, reference_line_id)
  where reason = 'consumption' and reference_line_id is not null;


-- =====================================================================
-- SECTION 210 — subject_types registry: register grooming_job_pet
-- =====================================================================
insert into public.subject_types (key, description)
values ('grooming_job_pet', 'Grooming job pet (per-pet execution record)')
on conflict (key) do nothing;


-- =====================================================================
-- SECTION 300 — BACKFILL legacy singular bookings (REVIEW ITEM 1)
-- ---------------------------------------------------------------------
-- Preserve existing data BEFORE dropping columns. For each grooming booking
-- with a pet_id: ensure a grooming_jobs row, one grooming_job_pet, and (if a
-- service_id is present) one grooming_job_pet_service from the booking snapshots.
-- Deterministic and idempotent (guards prevent double-insert on re-run).
-- =====================================================================

-- 3a. Ensure a grooming_jobs row exists for every grooming booking that has a
--     pet (so the per-pet child has a parent).
insert into public.grooming_jobs (booking_id, organization_id)
select b.id, b.organization_id
from public.bookings b
where b.booking_type = 'grooming'
  and b.pet_id is not null
  and not exists (select 1 from public.grooming_jobs gj
                  where gj.organization_id = b.organization_id and gj.booking_id = b.id);

-- 3b. One grooming_job_pet per legacy booking pet.
insert into public.grooming_job_pets
  (organization_id, grooming_job_id, pet_id, sequence, status, is_required)
select b.organization_id, b.id, b.pet_id, 1,
       case when b.status = 'completed' then 'complete' else 'pending' end,
       true
from public.bookings b
where b.booking_type = 'grooming'
  and b.pet_id is not null
  and not exists (select 1 from public.grooming_job_pets gjp
                  where gjp.organization_id = b.organization_id
                    and gjp.grooming_job_id = b.id and gjp.pet_id = b.pet_id);

-- 3c. One grooming_job_pet_service per legacy booking service (when present),
--     carrying forward the booking snapshots. Skips bookings with no service_id.
insert into public.grooming_job_pet_services
  (organization_id, grooming_job_pet_id, service_id, service_name_snapshot,
   unit_price_snapshot, currency, quantity)
select b.organization_id, gjp.id, b.service_id,
       coalesce(b.service_name_snapshot,
                (select sc.name from public.service_catalog sc
                 where sc.organization_id = b.organization_id and sc.id = b.service_id),
                'Legacy service'),
       coalesce(b.price_snapshot, 0),
       coalesce(b.currency, 'USD'),
       1
from public.bookings b
join public.grooming_job_pets gjp
  on gjp.organization_id = b.organization_id and gjp.grooming_job_id = b.id and gjp.pet_id = b.pet_id
where b.booking_type = 'grooming'
  and b.pet_id is not null
  and b.service_id is not null
  and not exists (select 1 from public.grooming_job_pet_services x
                  where x.organization_id = b.organization_id
                    and x.grooming_job_pet_id = gjp.id
                    and x.service_id = b.service_id);


-- =====================================================================
-- SECTION 310 — VALIDATE backfill; ABORT if any legacy row unmapped
-- ---------------------------------------------------------------------
-- REVIEW ITEM 1 (3,4): a deterministic check that every grooming booking with
-- a pet now has a matching grooming_job_pet, and every such booking with a
-- service has a matching line. If any remain unmapped, RAISE and abort the
-- whole migration (transactional) so no data is silently discarded.
-- The same SELECTs (without the abort) are the validation query in
-- BACKFILL_REPORT.md.
-- =====================================================================
do $$
declare
  v_unmapped_pets integer;
  v_unmapped_services integer;
  v_non_grooming_legacy integer;
begin
  select count(*) into v_unmapped_pets
  from public.bookings b
  where b.booking_type = 'grooming' and b.pet_id is not null
    and not exists (select 1 from public.grooming_job_pets gjp
                    where gjp.organization_id = b.organization_id
                      and gjp.grooming_job_id = b.id and gjp.pet_id = b.pet_id);

  select count(*) into v_unmapped_services
  from public.bookings b
  join public.grooming_job_pets gjp
    on gjp.organization_id = b.organization_id and gjp.grooming_job_id = b.id and gjp.pet_id = b.pet_id
  where b.booking_type = 'grooming' and b.pet_id is not null and b.service_id is not null
    and not exists (select 1 from public.grooming_job_pet_services x
                    where x.organization_id = b.organization_id
                      and x.grooming_job_pet_id = gjp.id and x.service_id = b.service_id);

  -- REVIEW ITEM 13: SECTION 300 only backfills booking_type='grooming' rows.
  -- If ANY other booking_type still carries a non-null pet_id or service_id,
  -- there is no mapping path for it and SECTION 320's unconditional column
  -- drop would silently discard that data. Abort instead — this vertical is
  -- ungated for anything other than grooming today; a future vertical must
  -- ship its own backfill (mirroring SECTION 300) before this guard can pass
  -- with that booking_type present.
  select count(*) into v_non_grooming_legacy
  from public.bookings b
  where b.booking_type <> 'grooming'
    and (b.pet_id is not null or b.service_id is not null);

  if v_unmapped_pets > 0 or v_unmapped_services > 0 or v_non_grooming_legacy > 0 then
    raise exception
      'BACKFILL ABORT: % booking pet(s), % booking service(s) unmapped, and % '
      'non-grooming booking(s) with legacy pet_id/service_id still populated; '
      'refusing to drop columns',
      v_unmapped_pets, v_unmapped_services, v_non_grooming_legacy
      using errcode = 'data_exception';
  end if;
  raise notice 'BACKFILL OK: all legacy grooming pet/service values mapped; '
    'no non-grooming booking carries pet_id/service_id.';
end $$;


-- =====================================================================
-- SECTION 320 — Core neutrality: DROP legacy columns (only after validate)
-- =====================================================================
alter table public.bookings drop constraint if exists fk_bookings_pets;
alter table public.bookings drop constraint if exists fk_bookings_service;
alter table public.bookings drop column     if exists pet_id;
alter table public.bookings drop column     if exists service_id;

comment on column public.bookings.service_name_snapshot is
  'DEMOTED (0013): non-authoritative display cache. Authoritative service data '
  'lives on grooming_job_pet_services. Not read by any resolver.';
comment on column public.bookings.price_snapshot is
  'DEMOTED (0013): non-authoritative cache. Authoritative price is per line; '
  'booking total is DERIVED from lines, never client-set.';
comment on column public.bookings.currency is
  'DEMOTED (0013): non-authoritative cache; per-line currency is authoritative.';


-- =====================================================================
-- SECTION 400 — Tenant-only authorization helpers (REVIEW ITEMS 3, 5)
-- ---------------------------------------------------------------------
-- These have NO app.is_platform_admin() shortcut: platform staff get no
-- automatic access to the new tenant data in 0013 (governed support access
-- arrives in 0014).
--
-- Two boolean helpers (usable inside RLS policies, which cannot call the
-- RAISE-based guard below) + one RAISE-based guard for RPC bodies.
-- =====================================================================

-- Boolean: does the current user hold a permission in the ACTIVE org (no admin)?
create or replace function app.tenant_has_permission(perm text)
returns boolean
security definer set search_path = app, public
language sql stable as $$
  select exists (
    select 1 from public.memberships m
    join public.role_permissions rp
      on rp.organization_id = m.organization_id and rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id
    where m.user_id = app.fn_current_user_id()
      and m.organization_id = app.fn_active_organization()
      and m.status = 'active' and m.deleted_at is null
      and p.key = perm);
$$;

-- Boolean: is a module enabled for the ACTIVE org (no admin bypass)?
create or replace function app.tenant_has_module(module_key text)
returns boolean
security definer set search_path = app, public
language sql stable as $$
  select exists (
    select 1 from public.organization_modules om
    join public.modules mo on mo.id = om.module_id
    where om.organization_id = app.fn_active_organization()
      and om.enabled and mo.is_active and mo.key = module_key);
$$;

-- Boolean: active membership in the ACTIVE org (no admin bypass)?
create or replace function app.tenant_has_membership()
returns boolean
security definer set search_path = app, public
language sql stable as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = app.fn_current_user_id()
      and m.organization_id = app.fn_active_organization()
      and m.status = 'active' and m.deleted_at is null);
$$;

-- Boolean: does the current user have access to a specific branch in the ACTIVE
-- org (FINAL PASS ITEM 2)? Access = an explicit membership_branch_access row OR
-- the 'branches.all' permission. This is the TENANT-ONLY analogue of the base
-- app.has_branch(): it deliberately has NO app.is_platform_admin() bypass,
-- consistent with 0013's rule that platform staff get no automatic access to
-- tenant grooming data (governed support access is 0014). A NULL branch means
-- "not branch-scoped" and passes (used by the branch-nullable policy form).
create or replace function app.tenant_has_branch(p_branch uuid)
returns boolean
security definer set search_path = app, public
language sql stable as $$
  select p_branch is null
      or app.tenant_has_permission('branches.all')
      or exists (
        select 1 from public.memberships m
        join public.membership_branch_access mba
          on mba.organization_id = m.organization_id and mba.membership_id = m.id
        where m.user_id = app.fn_current_user_id()
          and m.organization_id = app.fn_active_organization()
          and m.status = 'active' and m.deleted_at is null
          and mba.branch_id = p_branch);
$$;

-- RAISE-based guard for RPC bodies (org match + membership + module + perm +
-- optional branch). No platform-admin bypass; typed error strings.
create or replace function app.assert_tenant_authorized(
  p_org uuid, p_module text, p_perm text, p_branch uuid default null)
returns void
security definer set search_path = app, public
language plpgsql stable as $$
declare v_user uuid; v_has_branch boolean;
begin
  v_user := app.fn_current_user_id();

  if p_org is null or p_org <> app.fn_active_organization() then
    raise exception 'wrong_organization' using errcode = 'insufficient_privilege';
  end if;

  -- Active membership in the target org (NO platform-admin bypass).
  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_user and m.organization_id = p_org
      and m.status = 'active' and m.deleted_at is null) then
    raise exception 'no_active_membership' using errcode = 'insufficient_privilege';
  end if;

  -- Module entitlement (org state), no admin bypass.
  if p_module is not null and not exists (
    select 1 from public.organization_modules om
    join public.modules mo on mo.id = om.module_id
    where om.organization_id = p_org and mo.key = p_module and om.enabled) then
    raise exception 'missing_module:%', p_module using errcode = 'insufficient_privilege';
  end if;

  -- Permission via membership -> role -> role_permissions -> permissions.
  if p_perm is not null and not exists (
    select 1 from public.memberships m
    join public.role_permissions rp
      on rp.organization_id = m.organization_id and rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id
    where m.user_id = v_user and m.organization_id = p_org
      and m.status = 'active' and m.deleted_at is null and p.key = p_perm) then
    raise exception 'missing_permission:%', p_perm using errcode = 'insufficient_privilege';
  end if;

  -- Branch access when a branch is supplied: explicit grant or branches.all.
  if p_branch is not null then
    select (
      exists (select 1 from public.memberships m
              join public.role_permissions rp
                on rp.organization_id = m.organization_id and rp.role_id = m.role_id
              join public.permissions p on p.id = rp.permission_id
              where m.user_id = v_user and m.organization_id = p_org
                and m.status = 'active' and m.deleted_at is null and p.key = 'branches.all')
      or exists (select 1 from public.memberships m
                 join public.membership_branch_access mba
                   on mba.organization_id = m.organization_id and mba.membership_id = m.id
                 where m.user_id = v_user and m.organization_id = p_org
                   and m.status = 'active' and mba.branch_id = p_branch)
    ) into v_has_branch;
    if not v_has_branch then
      raise exception 'wrong_branch' using errcode = 'insufficient_privilege';
    end if;
  end if;
end; $$;


-- =====================================================================
-- SECTION 410 — Package reservation functions (secured; REVIEW ITEMS 3,6,7)
-- ---------------------------------------------------------------------
-- reserve_package_session is the ONLY client-callable reservation RPC. It
-- authorizes, validates the package fully, locks, checks availability, and
-- inserts. consume/release/reverse are INTERNAL (called only by the RPC /
-- cancellation / repair) and are NOT granted to authenticated.
-- =====================================================================

-- INTERNAL: availability = cache balance − active (reserved) reservations.
-- Accepts explicit org (internal callers already hold the resolved org). NOT
-- granted to authenticated — see the client RPC below.
create or replace function app.fn_package_available_sessions(p_org uuid, p_customer_package uuid)
returns integer
security definer set search_path = app, public
language sql stable as $$
  select coalesce(cp.sessions_remaining, 0)
       - coalesce((select count(*) from public.package_reservations pr
                   where pr.organization_id = p_org
                     and pr.customer_package_id = p_customer_package
                     and pr.status = 'reserved'), 0)
  from public.customer_packages cp
  where cp.organization_id = p_org and cp.id = p_customer_package;
$$;

-- CLIENT RPC (REVIEW ITEM 4): takes ONLY the package id, derives the active
-- org, validates tenant membership + booking.read, refuses cross-tenant access,
-- then returns availability. No caller-supplied org is trusted.
create or replace function app.package_available_sessions(p_customer_package uuid)
returns integer
security definer set search_path = app, public
language plpgsql stable as $$
declare v_org uuid;
begin
  v_org := app.fn_active_organization();
  -- The package must belong to the active org; else it is cross-tenant.
  if not exists (select 1 from public.customer_packages cp
                 where cp.id = p_customer_package and cp.organization_id = v_org) then
    raise exception 'package_not_found' using errcode = 'no_data_found';
  end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.read');
  return app.fn_package_available_sessions(v_org, p_customer_package);
end; $$;

-- Public RPC: reserve one session against a pet-service line.
create or replace function app.reserve_package_session(
  p_line uuid, p_customer_package uuid, p_expires_at timestamptz default null)
returns uuid
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid; ln record; cp record; v_booking_customer uuid; v_avail integer; v_id uuid;
  v_branch uuid;
begin
  v_org := app.fn_active_organization();

  -- Load line (must exist, same org, not deleted) AND its owning booking branch
  -- (FINAL PASS ITEM 2): chain line -> grooming_job_pet -> booking. The branch
  -- is passed into assert_tenant_authorized so a user restricted to another
  -- branch cannot reserve against this line even with the scheduling module and
  -- booking.update permission.
  select gjps.*, gjp.grooming_job_id, b.branch_id as booking_branch_id
    into ln
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp
    on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
  join public.bookings b
    on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
  where gjps.organization_id = v_org and gjps.id = p_line and gjps.deleted_at is null;
  if not found then
    raise exception 'line_not_found' using errcode = 'no_data_found';
  end if;
  v_branch := ln.booking_branch_id;

  -- Authorize: tenant-only (no platform-admin bypass), scheduling module +
  -- booking.update permission + access to the BOOKING'S BRANCH.
  perform app.assert_tenant_authorized(v_org, 'scheduling', 'booking.update', v_branch);

  -- Lock and validate the package (REVIEW ITEM 3 package checks).
  select * into cp from public.customer_packages
   where organization_id = v_org and id = p_customer_package for update;
  if not found then
    raise exception 'package_not_found' using errcode = 'no_data_found';
  end if;
  if cp.status <> 'active' then
    raise exception 'package_not_active' using errcode = 'check_violation';
  end if;
  if cp.expires_at is not null and cp.expires_at <= now() then
    raise exception 'package_expired' using errcode = 'check_violation';
  end if;
  -- Package must be applicable to the line's service (null service = any).
  if cp.service_id is not null and cp.service_id <> ln.service_id then
    raise exception 'package_not_applicable_to_service' using errcode = 'check_violation';
  end if;
  -- Package customer must match the booking's customer.
  select b.customer_id into v_booking_customer
  from public.bookings b
  where b.organization_id = v_org and b.id = ln.grooming_job_id;
  if v_booking_customer is null or v_booking_customer <> cp.customer_id then
    raise exception 'package_customer_mismatch' using errcode = 'check_violation';
  end if;

  -- Free capacity from any expired reservations first (idempotent), so a stale
  -- reserved row does not keep availability artificially low (REVIEW ITEM 9).
  perform app.expire_package_reservations(p_customer_package);

  -- Availability under the row lock (no oversubscription).
  v_avail := app.fn_package_available_sessions(v_org, p_customer_package);
  if v_avail <= 0 then
    raise exception 'no_sessions_available' using errcode = 'check_violation';
  end if;

  -- Insert reservation. uidx_pr_one_lifecycle_per_line guarantees <=1 per line.
  insert into public.package_reservations
    (organization_id, customer_package_id, grooming_job_pet_service_id, status, expires_at)
  values (v_org, p_customer_package, p_line, 'reserved', p_expires_at)
  returning id into v_id;

  return v_id;
end; $$;

-- INTERNAL: consume a reservation (idempotent). Called by complete_booking only.
create or replace function app.consume_package_reservation(p_reservation uuid)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare r record; v_ledger uuid;
begin
  select * into r from public.package_reservations where id = p_reservation for update;
  if not found then
    raise exception 'reservation_not_found' using errcode = 'no_data_found';
  end if;
  if r.status = 'consumed' then return; end if;           -- idempotent
  if r.status <> 'reserved' then
    raise exception 'reservation_not_reserved' using errcode = 'check_violation';
  end if;

  insert into public.customer_package_ledger
    (organization_id, customer_package_id, delta, reason, reference_booking_id,
     reference_line_id, notes)
  values (r.organization_id, r.customer_package_id, -1, 'consumption', null,
          r.grooming_job_pet_service_id, 'package reservation consumed')
  returning id into v_ledger;

  update public.package_reservations
     set status = 'consumed', consumed_at = now(), consumption_ledger_id = v_ledger
   where id = p_reservation;

  update public.customer_packages set status = 'exhausted'
   where organization_id = r.organization_id and id = r.customer_package_id
     and sessions_remaining <= 0;
end; $$;

-- INTERNAL: release a still-reserved reservation (cancellation path).
create or replace function app.release_package_reservation(p_reservation uuid)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare r record;
begin
  select * into r from public.package_reservations where id = p_reservation for update;
  if not found then return; end if;
  if r.status <> 'reserved' then return; end if;
  update public.package_reservations set status = 'released', released_at = now()
   where id = p_reservation;
end; $$;

-- INTERNAL: reverse a consumed reservation (REVIEW ITEM 7).
-- Writes a compensating +1 ledger row, marks the reservation 'released', and
-- PERMANENTLY leaves the line's lifecycle row in place. The line can never be
-- re-consumed (uidx_pr_one_lifecycle_per_line + uidx_cpl_consumption_per_line);
-- re-consumption requires a NEW corrected service line.
create or replace function app.reverse_package_reservation(p_reservation uuid)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare r record; v_ledger uuid;
begin
  select * into r from public.package_reservations where id = p_reservation for update;
  if not found then
    raise exception 'reservation_not_found' using errcode = 'no_data_found';
  end if;
  if r.status <> 'consumed' then return; end if;          -- only consumed can reverse
  if r.reversal_ledger_id is not null then return; end if;-- idempotent

  insert into public.customer_package_ledger
    (organization_id, customer_package_id, delta, reason, reference_booking_id,
     reference_line_id, notes)
  values (r.organization_id, r.customer_package_id, +1, 'adjustment', null,
          r.grooming_job_pet_service_id, 'package reservation reversed (compensating)')
  returning id into v_ledger;

  update public.package_reservations
     set status = 'released', released_at = now(), reversal_ledger_id = v_ledger
   where id = p_reservation;

  update public.customer_packages set status = 'active'
   where organization_id = r.organization_id and id = r.customer_package_id
     and sessions_remaining > 0 and status = 'exhausted';
end; $$;


-- INTERNAL: expire stale reservations (REVIEW ITEM 9). Idempotent. Under the
-- package row lock, any 'reserved' row whose expires_at is in the past becomes
-- 'expired', freeing its capacity. Audit history is preserved (status change is
-- audited by the table trigger; the row is never deleted). Called by the
-- reserve RPC (opportunistic, for the target package) and can be run by a
-- scheduled job across packages.
create or replace function app.expire_package_reservations(p_customer_package uuid)
returns integer
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid; v_count integer;
begin
  select organization_id into v_org from public.customer_packages
    where id = p_customer_package for update;
  if v_org is null then return 0; end if;

  with expired as (
    update public.package_reservations
       set status = 'expired', released_at = now()
     where customer_package_id = p_customer_package
       and organization_id = v_org
       and status = 'reserved'
       and expires_at is not null and expires_at <= now()
    returning 1)
  select count(*) into v_count from expired;
  return coalesce(v_count, 0);
end; $$;


-- =====================================================================
-- SECTION 420 — Per-line commission accrual (INTERNAL)
-- =====================================================================
create or replace function app.accrue_commission_for_line(p_line uuid)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare ln record; v_member uuid; v_base numeric(14,2); d jsonb;
begin
  select * into ln from public.grooming_job_pet_services where id = p_line for update;
  if not found then return; end if;

  if exists (select 1 from public.commission_entries
             where organization_id = ln.organization_id and reference_line_id = p_line) then
    return;  -- idempotent (uidx_commission_entries_line)
  end if;

  select r.membership_id into v_member
  from public.resources r
  where r.organization_id = ln.organization_id
    and r.id = coalesce(
      ln.assigned_resource_id,
      (select gjp.assigned_resource_id from public.grooming_job_pets gjp
       where gjp.organization_id = ln.organization_id and gjp.id = ln.grooming_job_pet_id))
    and r.membership_id is not null;

  if v_member is null then
    select r.membership_id into v_member
    from public.grooming_job_pets gjp
    join public.booking_resources br
      on br.organization_id = gjp.organization_id and br.booking_id = gjp.grooming_job_id
    join public.resources r
      on r.id = br.resource_id and r.organization_id = br.organization_id
    where gjp.organization_id = ln.organization_id and gjp.id = ln.grooming_job_pet_id
      and r.membership_id is not null
    order by br.created_at limit 1;
  end if;
  if v_member is null then return; end if;

  v_base := coalesce(ln.commission_basis, ln.unit_price_snapshot * ln.quantity, 0);
  d := app.resolve_commission(ln.organization_id, ln.service_id, v_base);
  if (d->>'commission_amount')::numeric <= 0 then return; end if;

  insert into public.commission_entries
    (organization_id, membership_id, reference_booking_id, reference_line_id,
     base_amount, rate_snapshot, commission_amount, currency)
  select ln.organization_id, v_member, gjp2.grooming_job_id, p_line,
         v_base, d, (d->>'commission_amount')::numeric, ln.currency
  from public.grooming_job_pets gjp2
  where gjp2.organization_id = ln.organization_id and gjp2.id = ln.grooming_job_pet_id;
end; $$;


-- =====================================================================
-- SECTION 430 — Per-line inventory consumption (INTERNAL)
-- =====================================================================
create or replace function app.consume_inventory_for_line(p_line uuid)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare ln record; v_branch uuid;
begin
  select * into ln from public.grooming_job_pet_services where id = p_line for update;
  if not found then return; end if;
  if ln.inventory_basis = 'none' then return; end if;

  if exists (select 1 from public.inventory_movements
             where organization_id = ln.organization_id and reference_line_id = p_line
               and movement_type = 'consumption') then
    return;  -- idempotent
  end if;

  select b.branch_id into v_branch
  from public.grooming_job_pets gjp
  join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
  where gjp.organization_id = ln.organization_id and gjp.id = ln.grooming_job_pet_id;
  if v_branch is null then return; end if;

  insert into public.inventory_movements
    (organization_id, branch_id, product_id, movement_type, quantity,
     reference_booking_id, reference_line_id, notes)
  select ln.organization_id, v_branch, sp.product_id, 'consumption',
         -(sp.quantity * ln.quantity),
         (select gjp.grooming_job_id from public.grooming_job_pets gjp
          where gjp.organization_id = ln.organization_id and gjp.id = ln.grooming_job_pet_id),
         p_line, 'auto: per-line service completion'
  from public.service_products sp
  where sp.organization_id = ln.organization_id and sp.service_id = ln.service_id;
end; $$;


-- =====================================================================
-- SECTION 600 — CompleteBooking RPC (secured; REVIEW ITEMS 3,4,8)
-- ---------------------------------------------------------------------
-- Sole path to status='completed'. Authorizes (booking.complete + scheduling
-- module + branch). Eligibility (REVIEW ITEM 8): requires >=1 non-deleted pet;
-- every REQUIRED pet must be 'complete'; a required pet that is 'skipped' or
-- otherwise not complete needs override+reason; optional pets may be skipped
-- freely. Each required pet must have >=1 service line. Fires per-line effects
-- exactly once (idempotent). No GUC, no admin exemption.
-- =====================================================================
create or replace function app.complete_booking(
  p_booking uuid, p_override boolean default false, p_reason text default null)
returns jsonb
security definer set search_path = app, public
language plpgsql as $$
declare
  b record; v_pets integer; v_incomplete_required integer;
  v_optional_in_flight integer;
  v_required_without_line integer; v_lines integer := 0; ln record;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then
    raise exception 'booking_not_found' using errcode = 'no_data_found';
  end if;

  -- Authorize against the booking's own org + branch (tenant-only; no
  -- platform-admin bypass — governed support access is 0014).
  perform app.assert_tenant_authorized(
    b.organization_id, 'scheduling', 'booking.complete', b.branch_id);

  if b.status = 'completed' then
    return jsonb_build_object('completed', true, 'booking_id', p_booking,
                              'lines_processed', 0, 'reason', 'already_completed');
  end if;
  if b.status not in ('confirmed','in_progress') then
    raise exception 'not_completable:%', b.status using errcode = 'check_violation';
  end if;

  -- Eligibility (REVIEW ITEM 8).
  select count(*) into v_pets
  from public.grooming_job_pets gjp
  where gjp.organization_id = b.organization_id and gjp.grooming_job_id = p_booking
    and gjp.deleted_at is null;
  if v_pets = 0 then
    raise exception 'no_pets_on_booking' using errcode = 'check_violation';
  end if;

  -- Every required pet must have at least one service line.
  select count(*) into v_required_without_line
  from public.grooming_job_pets gjp
  where gjp.organization_id = b.organization_id and gjp.grooming_job_id = p_booking
    and gjp.is_required and gjp.deleted_at is null
    and not exists (select 1 from public.grooming_job_pet_services x
                    where x.organization_id = gjp.organization_id
                      and x.grooming_job_pet_id = gjp.id and x.deleted_at is null);
  if v_required_without_line > 0 then
    raise exception 'required_pet_without_service_line' using errcode = 'check_violation';
  end if;

  -- Required pets not 'complete' (skipped/pending/in_progress) block unless
  -- override+reason (REVIEW ITEMS 7,8).
  select count(*) into v_incomplete_required
  from public.grooming_job_pets gjp
  where gjp.organization_id = b.organization_id and gjp.grooming_job_id = p_booking
    and gjp.is_required and gjp.deleted_at is null and gjp.status <> 'complete';
  if v_incomplete_required > 0 then
    if not p_override then
      raise exception 'not_eligible:% required pet(s) not complete', v_incomplete_required
        using errcode = 'check_violation';
    end if;
    if p_reason is null or length(btrim(p_reason)) = 0 then
      raise exception 'override_requires_reason' using errcode = 'check_violation';
    end if;
  end if;

  -- Optional pets must be complete OR skipped; a pending/in_progress optional
  -- pet blocks completion (REVIEW ITEM 7) and is NOT waived by override — the
  -- work is still in flight. (Skip it explicitly if you mean to skip it.)
  select count(*) into v_optional_in_flight
  from public.grooming_job_pets gjp
  where gjp.organization_id = b.organization_id and gjp.grooming_job_id = p_booking
    and not gjp.is_required and gjp.deleted_at is null
    and gjp.status in ('pending','in_progress');
  if v_optional_in_flight > 0 then
    raise exception 'optional_pet_in_flight:% optional pet(s) pending/in_progress',
      v_optional_in_flight using errcode = 'check_violation';
  end if;

  -- Transition exactly once. (Privilege layer, SECTION 610, blocks any direct
  -- client attempt; this function runs as owner so the UPDATE succeeds here.)
  update public.bookings set status = 'completed' where id = p_booking;

  -- Effects run ONLY for lines whose pet is 'complete' (REVIEW ITEM 7).
  -- Skipped or overridden-incomplete pets produce ZERO commission/inventory/
  -- package effects — override may close the booking but never treats undelivered
  -- work as delivered.
  for ln in
    select gjps.id,
           (select pr.id from public.package_reservations pr
            where pr.organization_id = gjps.organization_id
              and pr.grooming_job_pet_service_id = gjps.id
              and pr.status = 'reserved') as reservation_id
    from public.grooming_job_pet_services gjps
    join public.grooming_job_pets gjp
      on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
    where gjps.organization_id = b.organization_id
      and gjp.grooming_job_id = p_booking and gjps.deleted_at is null
      and gjp.status = 'complete'          -- <-- only delivered pets
  loop
    perform app.accrue_commission_for_line(ln.id);
    perform app.consume_inventory_for_line(ln.id);
    if ln.reservation_id is not null then
      perform app.consume_package_reservation(ln.reservation_id);
    end if;
    v_lines := v_lines + 1;
  end loop;

  -- Release reservations on skipped/incomplete lines (do NOT consume them).
  update public.package_reservations pr
     set status = 'released', released_at = now()
   from public.grooming_job_pet_services gjps
   join public.grooming_job_pets gjp
     on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
   where pr.organization_id = b.organization_id
     and pr.grooming_job_pet_service_id = gjps.id
     and pr.status = 'reserved'
     and gjp.grooming_job_id = p_booking
     and gjp.status <> 'complete';

  insert into public.timeline_events
    (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (b.organization_id, 'booking', p_booking, app.fn_current_user_id(),
          'booking.completed',
          case when p_override then 'Booking completed (admin override)'
               else 'Booking completed' end,
          jsonb_build_object('override', p_override, 'reason', p_reason,
                             'lines_processed', v_lines));

  return jsonb_build_object('completed', true, 'booking_id', p_booking,
                            'lines_processed', v_lines,
                            'reason', case when p_override then p_reason else null end);
end; $$;

comment on function app.complete_booking(uuid, boolean, text) is
  'Sole path to complete a booking. Authorizes (booking.complete + module + '
  'branch), validates eligibility, one transactional transition + per-line '
  'effects (idempotent) + timeline. No GUC, no admin exemption.';


-- =====================================================================
-- SECTION 610 — Privilege-based completion enforcement (REVIEW ITEMS 4, 10)
-- ---------------------------------------------------------------------
-- CHOSEN MECHANISM (documented): column-level privilege, not a session GUC.
--   1. Revoke UPDATE on bookings from authenticated, then re-grant UPDATE on
--      every booking column EXCEPT status. Authenticated clients therefore
--      cannot write bookings.status at all via PostgREST/SQL.
--   2. Status changes flow ONLY through owner-run SECURITY DEFINER functions:
--      app.transition_booking_status (non-completed lifecycle) and
--      app.complete_booking (the sole path to 'completed', which also runs the
--      per-line effects in the same transaction).
--   3. No client-settable variable is trusted; nothing to spoof.
--   4. Platform admins get NO bypass (they are `authenticated` at the SQL layer
--      and lack UPDATE(status)). There is NO privileged repair escape hatch in
--      0013 (REVIEW ITEM 10) — a governed repair belongs to 0014's
--      privileged_sessions + approval + immutable audit, not here.
--
-- NOTE: column-level GRANT cannot express "any column except status", so the
-- writable columns are enumerated. Keep in sync if booking columns change.
--
-- FINAL-PASS HARDENING (item 4): the booking commercial caches
-- service_name_snapshot / price_snapshot / currency are DEMOTED,
-- non-authoritative display caches (see the column comments in SECTION 320) —
-- the service lines are the commercial source of truth. Pass-3 still let
-- authenticated write these on both UPDATE (they were in the grant list) and
-- INSERT (the base-migration blanket INSERT grant covered every column). That
-- allowed a client to create a booking whose cached price/name/currency
-- disagree with the aggregated service-line truth. They are removed from the
-- authenticated UPDATE grant here AND from a re-scoped INSERT grant, so a
-- client can neither set nor change them directly. If a booking-level rollup is
-- ever needed it must be recomputed by an internal, database-controlled
-- function from the lines (deferred to Batch 2), never client-supplied.
-- =====================================================================
revoke update on public.bookings from authenticated;
grant update (
  branch_id, customer_id, booking_type, fulfillment_mode,
  starts_at, ends_at,
  notes, metadata, updated_at, updated_by, deleted_at
) on public.bookings to authenticated;
-- status is deliberately ABSENT (only the completion/transition RPCs write it).
-- service_name_snapshot / price_snapshot / currency are deliberately ABSENT
-- (non-authoritative caches; service lines are the source of truth).

-- Re-scope INSERT the same way: revoke the base-migration blanket INSERT and
-- re-grant it column-by-column WITHOUT status or the three commercial caches,
-- so a freshly-created booking cannot carry client-authored cache values that
-- contradict the lines. (A booking is created 'draft'/'requested' with no
-- lines yet; the caches have no legitimate client value at insert time.)
revoke insert on public.bookings from authenticated;
grant insert (
  id, organization_id, branch_id, customer_id, booking_type, fulfillment_mode,
  starts_at, ends_at, notes, metadata, created_by, created_at,
  updated_by, updated_at
) on public.bookings to authenticated;
-- status, service_name_snapshot, price_snapshot, currency deliberately ABSENT
-- from INSERT: status defaults via the table default / is moved by RPCs; the
-- caches are database-controlled only.


-- =====================================================================
-- SECTION 620 — Generic non-completion status transition (REVIEW ITEM 8)
-- ---------------------------------------------------------------------
-- The controlled, tenant-authorized way to move a booking through its
-- lifecycle WITHOUT completing it. Owner-run definer so it can write status
-- (which authenticated cannot). Enforces an explicit state machine and REFUSES
-- status='completed' (only app.complete_booking may reach that). Requires
-- booking.update + scheduling module + branch. Writes a timeline event.
--
-- Permitted transitions:
--   draft       -> requested | confirmed | canceled
--   requested   -> confirmed | canceled
--   confirmed   -> in_progress | canceled | no_show
--   in_progress -> canceled | no_show
--   (completed is NEVER reachable here; canceled/no_show are terminal)
-- =====================================================================
create or replace function app.transition_booking_status(
  p_booking uuid, p_to text)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare b record; v_ok boolean;
begin
  if p_to = 'completed' then
    raise exception 'use_complete_booking_for_completed' using errcode = 'check_violation';
  end if;
  select * into b from public.bookings where id = p_booking for update;
  if not found then raise exception 'booking_not_found' using errcode = 'no_data_found'; end if;

  perform app.assert_tenant_authorized(
    b.organization_id, 'scheduling', 'booking.update', b.branch_id);

  v_ok := case b.status
    when 'draft'       then p_to in ('requested','confirmed','canceled')
    when 'requested'   then p_to in ('confirmed','canceled')
    when 'confirmed'   then p_to in ('in_progress','canceled','no_show')
    when 'in_progress' then p_to in ('canceled','no_show')
    else false  -- completed / canceled / no_show are terminal here
  end;
  if not v_ok then
    raise exception 'invalid_transition:%->%', b.status, p_to using errcode = 'check_violation';
  end if;

  update public.bookings set status = p_to where id = p_booking;

  -- FINAL PASS ITEM 3: canceling or marking no-show must release every ACTIVE
  -- ('reserved') package reservation attached to this booking, in the same
  -- transaction, so held capacity is returned. Reservations are moved to
  -- 'released' (history preserved; rows never deleted). Idempotent by
  -- construction: only rows still 'reserved' are touched, so repeated
  -- cancel/no_show transitions cannot double-release (and the state machine
  -- above already makes canceled/no_show terminal, so a second transition from
  -- them is rejected anyway). Consuming a session for a no-show is deliberately
  -- NOT done here — that requires a separate explicit business operation and
  -- must never happen silently.
  if p_to in ('canceled','no_show') then
    update public.package_reservations pr
       set status = 'released', released_at = now()
      from public.grooming_job_pet_services gjps
      join public.grooming_job_pets gjp
        on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
     where pr.organization_id = b.organization_id
       and pr.grooming_job_pet_service_id = gjps.id
       and pr.status = 'reserved'
       and gjps.organization_id = b.organization_id
       and gjp.grooming_job_id = p_booking;
  end if;

  insert into public.timeline_events
    (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (b.organization_id, 'booking', p_booking, app.fn_current_user_id(),
          'booking.status_changed', format('Status %s -> %s', b.status, p_to),
          jsonb_build_object('from', b.status, 'to', p_to,
                             'reservations_released',
                             case when p_to in ('canceled','no_show') then true else false end));
end; $$;
comment on function app.transition_booking_status(uuid, text) is
  'Controlled non-completion lifecycle transitions (tenant-authorized). '
  'Rejects completed; only app.complete_booking may complete. Releases active '
  'package reservations on canceled/no_show (never consumes silently).';


-- =====================================================================
-- SECTION 700 — RLS: permissive isolation + restrictive capabilities
-- ---------------------------------------------------------------------
-- REVIEW ITEM 5: mirror 0010 (permissive org+membership) AND 0011
-- (restrictive module + read + per-command write capability).
-- =====================================================================
alter table public.grooming_job_pets          enable row level security;
alter table public.grooming_job_pet_services  enable row level security;
alter table public.package_reservations       enable row level security;

-- Tenant-only membership predicate reused by policies below. NO platform-admin
-- bypass (REVIEW ITEM 5): platform staff get no automatic access to this data.
-- app.assert_tenant_authorized cannot be used inside a policy (it RAISEs), so
-- policies inline the same membership existence check.

-- Permissive isolation: org match + active membership (tenant-only).
do $$
declare t text;
begin
  foreach t in array array[
    'grooming_job_pets','grooming_job_pet_services','package_reservations']
  loop
    execute format($f$
      create policy %1$s_org_isolation on public.%1$s for all
      using (organization_id = app.fn_active_organization()
             and exists (select 1 from public.memberships m
                         where m.user_id = app.fn_current_user_id()
                           and m.organization_id = %1$s.organization_id
                           and m.status = 'active' and m.deleted_at is null))
      with check (organization_id = app.fn_active_organization()
             and exists (select 1 from public.memberships m
                         where m.user_id = app.fn_current_user_id()
                           and m.organization_id = %1$s.organization_id
                           and m.status = 'active' and m.deleted_at is null));
    $f$, t);
  end loop;
end $$;

-- Restrictive capability layer (0011 pattern) — NO platform-admin bypass.
-- grooming_job_pets and grooming_job_pet_services: module 'scheduling',
-- read booking.read, writes booking.update. (Column-level protection of
-- authoritative fields on the line table is enforced by GRANTs in SECTION 720.)
do $$
declare t text;
begin
  foreach t in array array['grooming_job_pets','grooming_job_pet_services']
  loop
    execute format('create policy %1$s_module_gate on public.%1$s as restrictive for all '
      || 'using (app.tenant_has_module(''scheduling'')) with check (app.tenant_has_module(''scheduling''));', t);
    execute format('create policy %1$s_read_cap on public.%1$s as restrictive for select '
      || 'using (app.tenant_has_permission(''booking.read''));', t);
    execute format('create policy %1$s_write_ins on public.%1$s as restrictive for insert '
      || 'with check (app.tenant_has_permission(''booking.update''));', t);
    execute format('create policy %1$s_write_upd on public.%1$s as restrictive for update '
      || 'using (app.tenant_has_permission(''booking.update'')) with check (app.tenant_has_permission(''booking.update''));', t);
    -- NOTE (pass 3, REVIEW ITEM 14): DELETE is revoked from authenticated at
    -- the table-privilege layer in SECTION 720, so this policy is currently
    -- unreachable for authenticated. Kept as defense-in-depth in case a future
    -- migration re-grants DELETE without revisiting this file.
    execute format('create policy %1$s_write_del on public.%1$s as restrictive for delete '
      || 'using (app.tenant_has_permission(''booking.update''));', t);
  end loop;
end $$;

-- package_reservations (REVIEW ITEM 6): clients may READ permitted rows but
-- must NEVER directly write. All lifecycle changes go through the controlled
-- SECURITY DEFINER functions (owner-run, unaffected by these policies). Read
-- is gated by module 'membership' + permission 'membership.read'. There is NO
-- insert/update/delete policy, and SECTION 720 additionally revokes table DML,
-- so direct writes are impossible even with a permission.
create policy package_reservations_module_gate on public.package_reservations
  as restrictive for all
  using (app.tenant_has_module('membership')) with check (app.tenant_has_module('membership'));
create policy package_reservations_read_cap on public.package_reservations
  as restrictive for select
  using (app.tenant_has_permission('membership.read'));
-- (no write policies: no client insert/update/delete path)


-- =====================================================================
-- SECTION 705 — Branch-aware authorization (FINAL PASS ITEM 2)
-- ---------------------------------------------------------------------
-- Pass-3 policies only checked org membership + permission, so a user
-- restricted to Branch A could read/act on Branch-B grooming records within the
-- same org. Add RESTRICTIVE branch policies that derive the owning branch
-- through the authoritative chain and require app.tenant_has_branch() on it:
--
--   grooming_job_pets            -> bookings(id = grooming_job_id).branch_id
--   grooming_job_pet_services    -> grooming_job_pets -> bookings.branch_id
--   package_reservations (READ)  -> line -> grooming_job_pets -> bookings.branch_id
--
-- RESTRICTIVE policies AND with the existing permissive/capability layers, so a
-- row is visible/writable only when org + membership + permission + module AND
-- branch access all hold. No platform-admin bypass (tenant_has_branch has none).
-- A missing parent (defensive) yields no matching branch row -> denied.

-- grooming_job_pets: branch is the parent booking's branch.
create policy grooming_job_pets_branch on public.grooming_job_pets
  as restrictive for all
  using (exists (
    select 1 from public.bookings b
    where b.organization_id = grooming_job_pets.organization_id
      and b.id = grooming_job_pets.grooming_job_id
      and app.tenant_has_branch(b.branch_id)))
  with check (exists (
    select 1 from public.bookings b
    where b.organization_id = grooming_job_pets.organization_id
      and b.id = grooming_job_pets.grooming_job_id
      and app.tenant_has_branch(b.branch_id)));

-- grooming_job_pet_services: branch via its grooming_job_pet's booking.
create policy grooming_job_pet_services_branch on public.grooming_job_pet_services
  as restrictive for all
  using (exists (
    select 1 from public.grooming_job_pets gjp
    join public.bookings b
      on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    where gjp.organization_id = grooming_job_pet_services.organization_id
      and gjp.id = grooming_job_pet_services.grooming_job_pet_id
      and app.tenant_has_branch(b.branch_id)))
  with check (exists (
    select 1 from public.grooming_job_pets gjp
    join public.bookings b
      on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    where gjp.organization_id = grooming_job_pet_services.organization_id
      and gjp.id = grooming_job_pet_services.grooming_job_pet_id
      and app.tenant_has_branch(b.branch_id)));

-- package_reservations: READ is branch-gated via line -> pet -> booking. (There
-- is no client write path; the SECURITY DEFINER lifecycle functions run as
-- owner and are unaffected by RLS, and reserve_package_session itself now does
-- an explicit branch check — see SECTION 410.)
create policy package_reservations_branch on public.package_reservations
  as restrictive for select
  using (exists (
    select 1 from public.grooming_job_pet_services gjps
    join public.grooming_job_pets gjp
      on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
    join public.bookings b
      on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
    where gjps.organization_id = package_reservations.organization_id
      and gjps.id = package_reservations.grooming_job_pet_service_id
      and app.tenant_has_branch(b.branch_id)));


-- =====================================================================
-- SECTION 710 — Function privileges (REVIEW ITEM 3)
-- ---------------------------------------------------------------------
-- 0010 blanket-granted execute on all app functions to authenticated. Correct
-- that here: internal effect functions must NOT be client-callable. Only the
-- explicitly public RPCs are granted; internals are revoked from PUBLIC and
-- authenticated. (They still execute fine when called from inside a SECURITY
-- DEFINER function, which runs as the owner.)
-- =====================================================================
-- Public, client-callable RPCs (REVIEW ITEM 15, pass 3): Postgres GRANTs
-- EXECUTE to PUBLIC by default on CREATE FUNCTION. Pass-2 granted these to
-- `authenticated` but never stripped that default PUBLIC grant, so every role
-- connectable to the database (including anon/unauthenticated, in a typical
-- PostgREST/Supabase setup) could already call them — the internal
-- app.assert_tenant_authorized check inside each still enforced org/membership,
-- so this was not a full bypass, but it was not least-privilege and was
-- inconsistent with the file's own stated intent. Explicitly revoke from
-- PUBLIC, then grant only to authenticated.
revoke execute on function app.reserve_package_session(uuid, uuid, timestamptz) from public;
revoke execute on function app.complete_booking(uuid, boolean, text)            from public;
revoke execute on function app.transition_booking_status(uuid, text)            from public;
revoke execute on function app.package_available_sessions(uuid)                from public;
grant execute on function app.reserve_package_session(uuid, uuid, timestamptz) to authenticated;
grant execute on function app.complete_booking(uuid, boolean, text)            to authenticated;
grant execute on function app.transition_booking_status(uuid, text)            to authenticated;
grant execute on function app.package_available_sessions(uuid)                 to authenticated;

-- Internal functions — revoke from PUBLIC and authenticated (callable only from
-- inside owner-run SECURITY DEFINER functions):
revoke execute on function app.fn_package_available_sessions(uuid, uuid) from public, authenticated;
revoke execute on function app.consume_package_reservation(uuid) from public, authenticated;
revoke execute on function app.release_package_reservation(uuid) from public, authenticated;
revoke execute on function app.reverse_package_reservation(uuid) from public, authenticated;
revoke execute on function app.expire_package_reservations(uuid) from public, authenticated;
revoke execute on function app.accrue_commission_for_line(uuid) from public, authenticated;
revoke execute on function app.consume_inventory_for_line(uuid) from public, authenticated;
revoke execute on function app.assert_tenant_authorized(uuid, text, text, uuid) from public, authenticated;
-- Tenant boolean helpers are called BY the RLS policies on the new tables. RLS
-- policy expressions execute as the INVOKING role, so authenticated MUST retain
-- EXECUTE on them or every policy check errors. They are SECURITY DEFINER and
-- read only membership/entitlement for the active org (no data leak, no admin
-- bypass), so granting execute to authenticated is safe. PUBLIC is explicitly
-- stripped (REVIEW ITEM 15, pass 3) — same default-PUBLIC-grant gap as above;
-- anon/unauthenticated roles have no legitimate reason to call these.
revoke execute on function app.tenant_has_permission(text) from public;
revoke execute on function app.tenant_has_module(text) from public;
revoke execute on function app.tenant_has_membership() from public;
revoke execute on function app.tenant_has_branch(uuid) from public;
grant execute on function app.tenant_has_permission(text) to authenticated;
grant execute on function app.tenant_has_module(text) to authenticated;
grant execute on function app.tenant_has_membership() to authenticated;
-- tenant_has_branch is called by the SECTION 705 branch policies, which execute
-- as the invoking role, so authenticated must retain EXECUTE (FINAL PASS ITEM 2).
grant execute on function app.tenant_has_branch(uuid) to authenticated;

-- The commission-entry freeze trigger function (SECTION 110) is invoked only
-- via trigger context, never directly, but strip the default PUBLIC EXECUTE
-- grant for defense-in-depth consistency with the rest of this section.
revoke execute on function public.tg_commission_entries_freeze() from public;


-- =====================================================================
-- SECTION 720 — Table + column DML privileges (REVIEW ITEM 6; FINAL PASS ITEM 1)
-- ---------------------------------------------------------------------
-- FINAL-PASS HARDENING (item 1): pass-3 still allowed authenticated to directly
-- INSERT grooming_job_pets / grooming_job_pet_services and to UPDATE the whole
-- grooming_job_pets row. That let a client fabricate authoritative records
-- (wrong org/booking/pet/is_required, spoofed created_by, arbitrary sequence)
-- with no server mediation — the exact thing the "RPC-controlled" claim
-- implied was impossible. Until Batch 2 ships BookingAssembly + controlled
-- mutation RPCs, the honest posture is: authenticated may SELECT authorized
-- rows and directly UPDATE only a few genuinely-safe operational columns; it
-- may NOT directly INSERT or DELETE any of the three authoritative tables.
--
-- These privileges are what the "RPC-controlled" claim rests on; they are
-- proven by the live TCREATE*/TPROT* tests in 0013_test_core_neutrality.sql.

-- ---- grooming_job_pets --------------------------------------------------
-- SELECT + narrow UPDATE only. NO direct INSERT, NO direct DELETE.
-- Authoritative/identity columns that a client must never directly write:
--   organization_id, grooming_job_id, pet_id, is_required, evidence_required,
--   sequence, assigned_resource_id (authoritative assignment), created_by,
--   created_at, id — all ABSENT from the column-UPDATE grant below.
-- Safe operational columns a groomer legitimately edits in-flight:
--   status (pending/in_progress/complete/skipped is operational execution
--   state, not commercial identity), instructions, warnings, preferences,
--   metadata, updated_at, updated_by.
-- TARGETED FINAL PATCH: deleted_at is NO LONGER client-updatable. Direct
-- soft-delete let a client remove a REQUIRED pet from completion eligibility,
-- commission, inventory, and package consumption (complete_booking excludes
-- deleted_at IS NOT NULL rows), which is exactly the effect-manipulation that
-- revoking SQL DELETE was meant to prevent. Controlled soft-deletion (with
-- reason + audit) is a Batch 2 operation; there is no direct client path here.
-- NOTE: `sequence` and `assigned_resource_id` are treated as authoritative
-- here (they drive effect routing / commission resolution) and are therefore
-- deliberately excluded; Batch 2's controlled ops will manage them.
revoke all on public.grooming_job_pets from authenticated;
grant select on public.grooming_job_pets to authenticated;
grant update (
  status, instructions, warnings, preferences, metadata,
  updated_at, updated_by
) on public.grooming_job_pets to authenticated;
-- No INSERT grant, no DELETE grant, no table-level UPDATE grant, no deleted_at.

-- ---- grooming_job_pet_services -----------------------------------------
-- SELECT + narrow UPDATE only. NO direct INSERT, NO direct DELETE.
-- Authoritative commercial/effect/identity columns a client must never write:
--   organization_id, grooming_job_pet_id, service_id, service_name_snapshot,
--   unit_price_snapshot, currency, commission_basis, inventory_basis,
--   assigned_resource_id (effect/source identity), created_by, created_at, id
--   — all ABSENT below.
-- Safe operational columns: duration_minutes, instructions, metadata,
--   updated_at, updated_by.
-- TARGETED FINAL PATCH: `quantity` and `deleted_at` are NO LONGER client-
-- updatable.
--   * quantity directly drives commission basis (unit_price_snapshot *
--     quantity) and inventory consumption (service_product.quantity *
--     line.quantity), so a direct client write is financial/inventory-effect
--     manipulation. It is authoritative, not operational.
--   * deleted_at direct soft-delete would drop a required service line from
--     completion eligibility, commission, inventory, and package consumption
--     (complete_booking excludes deleted_at IS NOT NULL rows) — the same
--     effect-manipulation that revoking SQL DELETE was meant to prevent.
--   Changing quantity and controlled soft-deletion (with reason + audit) are
--   Batch 2 operations. service_name_snapshot stays PROTECTED as before.
revoke all on public.grooming_job_pet_services from authenticated;
grant select on public.grooming_job_pet_services to authenticated;
grant update (
  duration_minutes, instructions, metadata,
  updated_at, updated_by
) on public.grooming_job_pet_services to authenticated;
-- No INSERT grant, no DELETE grant, no table-level UPDATE grant, no quantity,
-- no deleted_at.

-- ---- package_reservations ----------------------------------------------
-- SELECT only. Every lifecycle change goes through owner-run SECURITY DEFINER
-- functions. No INSERT/UPDATE/DELETE at all.
revoke all on public.package_reservations from authenticated;
grant select on public.package_reservations to authenticated;


-- =====================================================================
-- SECTION 900 — Rollback notes (reverse order; destructive where noted)
-- ---------------------------------------------------------------------
-- -- re-grant full UPDATE on bookings to authenticated (revert 610):
-- grant update on public.bookings to authenticated;
-- drop function if exists app.complete_booking(uuid,boolean,text);
-- drop function if exists app.consume_inventory_for_line(uuid);
-- drop function if exists app.accrue_commission_for_line(uuid);
-- drop function if exists app.reverse_package_reservation(uuid);
-- drop function if exists app.release_package_reservation(uuid);
-- drop function if exists app.consume_package_reservation(uuid);
-- drop function if exists app.reserve_package_session(uuid,uuid,timestamptz);
-- drop function if exists app.package_available_sessions(uuid,uuid);
-- drop function if exists app.assert_tenant_authorized(uuid,text,text,uuid);
-- drop function if exists app.tenant_has_permission(text);
-- drop function if exists app.tenant_has_module(text);
-- drop function if exists app.tenant_has_membership(text);
-- alter table public.customer_package_ledger drop column if exists reference_line_id;
-- alter table public.inventory_movements    drop column if exists reference_line_id;
-- alter table public.commission_entries     drop column if exists reference_line_id;
-- delete from public.subject_types where key = 'grooming_job_pet';
-- drop table if exists public.package_reservations cascade;
-- drop table if exists public.grooming_job_pet_services cascade;
-- drop table if exists public.grooming_job_pets cascade;
-- alter table public.grooming_jobs drop constraint if exists uq_grooming_jobs_org_id;
-- -- NOTE: restoring bookings.pet_id/service_id + their data from the line
-- -- tables is a data-migration exercise; see BACKFILL_REPORT.md.

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- END 0013_core_neutrality_grooming_lines
-- =====================================================================
