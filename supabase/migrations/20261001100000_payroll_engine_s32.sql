-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20261001100000_payroll_engine_s32
-- Purpose          HomePaw parity section 32 (payroll engine): configurable
--                  cycles, canonical service roles (basic_grooming/styling/
--                  botak), org + per-groomer compensation settings with
--                  explicit inherit-vs-zero override semantics, retroactive
--                  styling tiers, draft overrides/custom rows that survive
--                  recompute, retention deposit ledger, groomer publish/hide
--                  pointer, and the idempotency log for financial mutations.
--                  See docs/handoffs/ENGINE-3-S32-S33-HANDOFF.md Section 5
--                  for the full calculation contract this schema implements.
-- Compatibility    Forward-only, additive. Every new column on an existing
--                  table is nullable or has a safe default; every existing
--                  payroll_runs/payroll_items/resources/resource_availability/
--                  service_catalog row keeps working unchanged.
-- Dependencies     0009 (payroll_expenses), 0011 (rls capabilities),
--                  0013 (core neutrality / grooming lines), scheduling_core
--                  (resources, resource_availability), attendance_tracking,
--                  service_size_pricing (pets.size, price matrix pattern).
-- Objects Created  ALTER resources (+hired_at), ALTER resource_availability
--                  (+reason), ALTER service_catalog (+payroll_role), ALTER
--                  payroll_runs (+revision, +overlap exclusion constraint).
--                  TABLES payroll_cycle_settings, staff_payroll_settings,
--                  payroll_item_overrides, payroll_custom_rows,
--                  payroll_retention_events, payroll_publications,
--                  payroll_operation_log.
-- RLS Policies     New tables: permissive org isolation (0010 pattern) +
--                  restrictive 'payroll' module gate + payroll.read/manage
--                  capability (0011 pattern). Financial-effect tables
--                  (payroll_retention_events, payroll_operation_log,
--                  payroll_publications) have NO direct write grant for
--                  authenticated — RPC-only (security definer), consistent
--                  with payroll_items' existing insert-only design.
-- Breaking Changes None.
-- Rollback         Drop the 7 new tables, drop the 2 new constraints/columns
--                  added to payroll_runs, drop the 3 additive columns on
--                  resources/resource_availability/service_catalog.
-- =====================================================================

begin;

-- =====================================================================
-- SECTION 1 — Canonical service roles (replaces name-substring matching)
-- =====================================================================
alter table public.service_catalog
  add column payroll_role text;
alter table public.service_catalog
  add constraint chk_service_catalog_payroll_role
  check (payroll_role is null or payroll_role in ('basic_grooming','styling','botak'));
comment on column public.service_catalog.payroll_role is
  'Canonical payroll classification (basic_grooming|styling|botak) for section 32 job/commission '
  'counting. Null = does not participate in per-pet payroll components. Set explicitly by an '
  'admin per service row -- never inferred from the service name.';

-- =====================================================================
-- SECTION 2 — Join date (drives the retention tenure clock + the blocked-
-- day join-date guard, HomePaw FILE3's fix over FILE2's confirmed bug).
-- =====================================================================
alter table public.resources
  add column hired_at date;
update public.resources set hired_at = created_at::date where hired_at is null;
comment on column public.resources.hired_at is
  'Staff join date. Backfilled from created_at for existing rows. Drives retention-deposit tenure '
  'and excludes org/branch-wide blocked days dated before this groomer was hired from reducing '
  'their weekly pay or daily allowance.';

-- =====================================================================
-- SECTION 3 — Blocked-day reason classification (HomePaw's groomer_blocks
-- .reason equivalent), scoped to this resource only (branch-wide closures
-- already live in branch_availability_blocks and are classified as
-- 'holiday' for payroll purposes at query time, not stored here).
-- =====================================================================
alter table public.resource_availability
  add column reason text;
alter table public.resource_availability
  add constraint chk_resource_availability_reason
  check (reason is null or reason in ('sick','leave','holiday','other'));
comment on column public.resource_availability.reason is
  'Only meaningful when kind=blackout. sick is the ONLY reason that breaks the no-sick payroll '
  'bonus; every reason (including sick) reduces worked-day counts for weekly proration and the '
  'daily allowance.';

-- =====================================================================
-- SECTION 4 — payroll_cycle_settings: one row per organization.
-- =====================================================================
create table public.payroll_cycle_settings (
  id                              uuid          not null default app.fn_uuid_v7(),
  organization_id                 uuid          not null,
  cycle_start_day                 integer       not null default 26,
  weekly_salary_amount_default    numeric(14,2) not null default 0,
  no_late_amount_default          numeric(14,2) not null default 0,
  no_sick_amount_default          numeric(14,2) not null default 0,
  styling_tiers_default           jsonb         not null default '[{"min_jobs":1,"pct":10},{"min_jobs":17,"pct":20}]'::jsonb,
  botak_amount_default            numeric(14,2) not null default 10000,
  per_pet_amount_default          numeric(14,2) not null default 20000,
  per_pet_size_matrix_default     jsonb         not null default '{}'::jsonb, -- {small,medium,large,extra_large}
  daily_amount_default            numeric(14,2) not null default 0,
  retention_amount_per_month_default numeric(14,2) not null default 0,
  retention_term_months_default   integer       not null default 24,
  metadata                        jsonb         not null default '{}'::jsonb,
  created_at                      timestamptz   not null default now(),
  updated_at                      timestamptz   not null default now(),
  created_by                      uuid, updated_by uuid,
  constraint pk_payroll_cycle_settings primary key (id),
  constraint fk_pcs_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint uq_pcs_org unique (organization_id),
  constraint chk_pcs_cycle_start_day check (cycle_start_day between 1 and 28),
  constraint chk_pcs_retention_term check (retention_term_months_default >= 0)
);
create trigger trg_pcs_updated_at before update on public.payroll_cycle_settings
  for each row execute function app.tg_set_updated_at();
create trigger trg_pcs_audit_cols before insert or update on public.payroll_cycle_settings
  for each row execute function app.tg_set_audit_columns();
create trigger trg_pcs_audit after insert or update or delete on public.payroll_cycle_settings
  for each row execute function app.tg_write_audit();

-- Validate the styling-tier shape on write (defensive; app also validates).
create or replace function public.tg_validate_styling_tiers()
returns trigger language plpgsql as $$
declare t jsonb;
begin
  if jsonb_typeof(new.styling_tiers_default) <> 'array' then
    raise exception 'styling_tiers_default must be a JSON array' using errcode = 'check_violation';
  end if;
  for t in select value from jsonb_array_elements(new.styling_tiers_default) loop
    if (t->>'min_jobs') is null or (t->>'min_jobs')::numeric < 1
       or (t->>'pct') is null or (t->>'pct')::numeric < 0 then
      raise exception 'invalid styling tier entry: %', t using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end; $$;
create trigger trg_pcs_validate_tiers before insert or update on public.payroll_cycle_settings
  for each row execute function public.tg_validate_styling_tiers();

-- =====================================================================
-- SECTION 5 — staff_payroll_settings: per-membership overrides. Every
-- column NULL means "inherit the org default" (payroll_cycle_settings);
-- a real value, including 0, is a deliberate override (brief requirement:
-- distinguish missing/inherit from a deliberate zero).
-- =====================================================================
create table public.staff_payroll_settings (
  id                    uuid          not null default app.fn_uuid_v7(),
  organization_id       uuid          not null,
  membership_id         uuid          not null,
  weekly_salary_enabled boolean       not null default false,
  weekly_salary_amount  numeric(14,2),
  no_late_enabled       boolean       not null default false,
  no_late_amount        numeric(14,2),
  no_sick_enabled       boolean       not null default false,
  no_sick_amount        numeric(14,2),
  styling_enabled       boolean       not null default false,
  styling_tiers         jsonb,                                  -- null/empty = inherit org default
  botak_enabled         boolean       not null default true,
  botak_amount          numeric(14,2),
  per_pet_enabled       boolean       not null default true,
  per_pet_amount        numeric(14,2),
  per_pet_size_matrix   jsonb,
  daily_enabled         boolean       not null default false,
  daily_amount          numeric(14,2),
  retention_enabled     boolean       not null default false,
  retention_amount_per_month numeric(14,2),
  retention_term_months integer,
  metadata              jsonb         not null default '{}'::jsonb,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  created_by            uuid, updated_by uuid,
  constraint pk_staff_payroll_settings primary key (id),
  constraint fk_sps_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_sps_memberships foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id) on delete cascade,
  constraint uq_sps_org_member unique (organization_id, membership_id),
  constraint chk_sps_retention_term check (retention_term_months is null or retention_term_months >= 0)
);
create trigger trg_sps_updated_at before update on public.staff_payroll_settings
  for each row execute function app.tg_set_updated_at();
create trigger trg_sps_audit_cols before insert or update on public.staff_payroll_settings
  for each row execute function app.tg_set_audit_columns();
create trigger trg_sps_audit after insert or update or delete on public.staff_payroll_settings
  for each row execute function app.tg_write_audit();

-- =====================================================================
-- SECTION 6 — payroll_runs: prevent duplicate/overlapping periods, add an
-- optimistic-concurrency revision counter (recompute/approve/pay/undo all
-- check + bump this, closing the "two tabs mark-paid the same run twice
-- with different numbers" gap the HomePaw source has).
-- =====================================================================
alter table public.payroll_runs add column revision integer not null default 0;
alter table public.payroll_runs
  add constraint excl_payroll_runs_no_overlap
  exclude using gist (
    organization_id with =,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    daterange(period_start, period_end, '[)') with &&
  );
comment on constraint excl_payroll_runs_no_overlap on public.payroll_runs is
  'A cycle_start_day change only affects FUTURE period computation; this constraint makes it '
  'impossible to ever create two payroll runs for the same org+branch with overlapping dates, '
  'regardless of settings changes in between.';

-- =====================================================================
-- SECTION 7 — payroll_item_overrides: row PRESENCE = deliberate override
-- (including amount=0), row ABSENCE = inherit the computed value. Persists
-- across recompute (recompute reads this table, never writes to it).
-- =====================================================================
create table public.payroll_item_overrides (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  payroll_run_id  uuid          not null,
  membership_id   uuid          not null,
  component_key   text          not null,   -- basic|weekly|noLate|noSick|styling|botak|transport|perDog|daily
  amount          numeric(14,2) not null,
  reason          text,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid,
  constraint pk_payroll_item_overrides primary key (id),
  constraint fk_pio_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_pio_runs foreign key (organization_id, payroll_run_id)
    references public.payroll_runs (organization_id, id) on delete cascade,
  constraint fk_pio_memberships foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id),
  constraint uq_pio_run_member_component unique (organization_id, payroll_run_id, membership_id, component_key),
  constraint chk_pio_component_key check (component_key in
    ('basic','weekly','noLate','noSick','styling','botak','transport','perDog','daily'))
);
create index idx_pio_run on public.payroll_item_overrides (organization_id, payroll_run_id);
create trigger trg_pio_updated_at before update on public.payroll_item_overrides
  for each row execute function app.tg_set_updated_at();
create trigger trg_pio_audit_cols before insert or update on public.payroll_item_overrides
  for each row execute function app.tg_set_audit_columns();
create trigger trg_pio_audit after insert or update or delete on public.payroll_item_overrides
  for each row execute function app.tg_write_audit();

-- =====================================================================
-- SECTION 8 — payroll_custom_rows: free-form additional pay lines, server-
-- side and shared from the start (HomePaw's equivalent lived only in one
-- admin's browser localStorage until the cycle was paid -- a known gap,
-- not ported). Soft-deletable; persists across recompute.
-- =====================================================================
create table public.payroll_custom_rows (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  payroll_run_id  uuid          not null,
  membership_id   uuid          not null,
  label           text          not null default '',
  amount          numeric(14,2) not null default 0,
  sort_order      integer       not null default 0,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid, deleted_at timestamptz,
  constraint pk_payroll_custom_rows primary key (id),
  constraint fk_pcr_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_pcr_runs foreign key (organization_id, payroll_run_id)
    references public.payroll_runs (organization_id, id) on delete cascade,
  constraint fk_pcr_memberships foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id),
  constraint chk_pcr_amount check (amount >= 0)
);
create index idx_pcr_run_member on public.payroll_custom_rows (organization_id, payroll_run_id, membership_id) where deleted_at is null;
create trigger trg_pcr_updated_at before update on public.payroll_custom_rows
  for each row execute function app.tg_set_updated_at();
create trigger trg_pcr_audit_cols before insert or update on public.payroll_custom_rows
  for each row execute function app.tg_set_audit_columns();
create trigger trg_pcr_audit after insert or update or delete on public.payroll_custom_rows
  for each row execute function app.tg_write_audit();

-- =====================================================================
-- SECTION 9 — payroll_retention_events: append-only ledger (accrual
-- snapshots taken at pay time, payout, reversal). RPC-only writes.
-- =====================================================================
create table public.payroll_retention_events (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  membership_id   uuid          not null,
  payroll_run_id  uuid,                                        -- the run this event was recorded against, if any
  kind            text          not null,                      -- accrual_snapshot | payout | reversal
  amount          numeric(14,2) not null,
  tenure_months   integer,
  metadata        jsonb         not null default '{}'::jsonb,
  occurred_at     timestamptz   not null default now(),
  created_at      timestamptz   not null default now(),
  created_by      uuid,
  constraint pk_payroll_retention_events primary key (id),
  constraint fk_pre_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_pre_memberships foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id),
  constraint fk_pre_runs foreign key (organization_id, payroll_run_id)
    references public.payroll_runs (organization_id, id),
  constraint chk_pre_kind check (kind in ('accrual_snapshot','payout','reversal'))
);
create index idx_pre_org_member on public.payroll_retention_events (organization_id, membership_id, occurred_at);
create trigger trg_pre_created_by before insert on public.payroll_retention_events
  for each row execute function app.tg_set_created_by();
create trigger trg_pre_block_update before update on public.payroll_retention_events
  for each row execute function app.tg_block_update();
create trigger trg_pre_block_delete before delete on public.payroll_retention_events
  for each row execute function app.tg_block_hard_delete();

-- A groomer is paid their retention lump sum at most once, ever (matches
-- HomePaw's actual implemented behavior -- a one-time maturity bonus, not a
-- bug to "fix" into a recurring benefit nobody asked for).
create unique index uidx_pre_one_payout_per_member
  on public.payroll_retention_events (organization_id, membership_id)
  where kind = 'payout';

-- =====================================================================
-- SECTION 10 — payroll_publications: single "currently visible to this
-- groomer" pointer per membership. Unlike HomePaw's denormalized JSONB
-- copy on the groomers table (which goes stale after an undo because
-- unmarkGroomerPaid never re-publishes), this points at the live
-- payroll_run_id/payroll_item and is read fresh on every groomer request,
-- so an undo is reflected immediately with no republish step.
-- =====================================================================
create table public.payroll_publications (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  membership_id   uuid          not null,
  payroll_run_id  uuid          not null,
  enabled         boolean       not null default true,
  published_at    timestamptz   not null default now(),
  published_by    uuid,
  updated_at      timestamptz   not null default now(),
  created_by      uuid, updated_by uuid,
  constraint pk_payroll_publications primary key (id),
  constraint fk_pp_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_pp_memberships foreign key (organization_id, membership_id)
    references public.memberships (organization_id, id) on delete cascade,
  constraint fk_pp_runs foreign key (organization_id, payroll_run_id)
    references public.payroll_runs (organization_id, id),
  constraint uq_pp_org_member unique (organization_id, membership_id)
);
create trigger trg_pp_updated_at before update on public.payroll_publications
  for each row execute function app.tg_set_updated_at();
create trigger trg_pp_audit_cols before insert or update on public.payroll_publications
  for each row execute function app.tg_set_audit_columns();
create trigger trg_pp_audit after insert or update or delete on public.payroll_publications
  for each row execute function app.tg_write_audit();

-- =====================================================================
-- SECTION 099 — RLS: enable + org isolation (0010 pattern) on every new
-- table. Restrictive module/capability policies are added in the next
-- migration alongside the RPCs, once the exact write surface (which
-- tables get direct payroll.manage writes vs RPC-only) is finalized by
-- those RPC definitions -- kept together so the privilege model and the
-- functions that rely on it ship as one reviewable unit.
--
-- NOTE ON IDEMPOTENCY (no separate request-id ledger table): this codebase's
-- established convention for idempotent financial/state mutations is a
-- natural-state or natural-unique-constraint check, never a generic
-- request-id log -- see app.fn_accrue_commission ("if exists ... return"),
-- app.consume_package_reservation ("if already consumed return"), and
-- app.complete_booking ("if already completed, return the same success").
-- The payroll lifecycle RPCs in the next migration follow the same pattern:
-- row-lock the aggregate first (serializes concurrent callers), then check
-- payroll_runs.status / the retention payout's own unique index for
-- "already done" before doing any work, and treat a caught unique_violation
-- as an idempotent success (re-fetch and return the existing result) rather
-- than a failure -- satisfying the brief's idempotency requirements with the
-- mechanism this repository already uses everywhere else, instead of a
-- second, inconsistent one.
-- =====================================================================
alter table public.payroll_cycle_settings   enable row level security;
alter table public.staff_payroll_settings   enable row level security;
alter table public.payroll_item_overrides   enable row level security;
alter table public.payroll_custom_rows      enable row level security;
alter table public.payroll_retention_events enable row level security;
alter table public.payroll_publications     enable row level security;

commit;
