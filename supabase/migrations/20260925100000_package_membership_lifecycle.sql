-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20260925100000_package_membership_lifecycle
-- Purpose          HomePaw parity sections 23-26: coverage detection,
--                  packages/memberships lifecycle, membership
--                  administration and subscription reconciliation.
-- Compatibility    Forward-only, additive. New columns are nullable or
--                  zero/default-valued and backfilled from existing
--                  metadata, so every existing package, reservation and
--                  invoice row keeps working unchanged. No existing
--                  migration is edited. `reserve_package_session` and
--                  `create_package_invoice` are extended via CREATE OR
--                  REPLACE / DROP+CREATE with backward-compatible
--                  (defaulted / additive) signatures -- every existing
--                  caller that omits the new arguments behaves exactly
--                  as before (no pet set => no pet restriction).
-- Objects Changed  ALTER customer_package_ledger (+request_key,
--                  widened reason enum to add 'renewal'). ALTER packages
--                  (+recurrence_interval, +per_pet). ALTER
--                  customer_packages (+source_invoice_id, +pet_id,
--                  +activated_at, +renewed_at, +renewal_count,
--                  +revision), backfilled from metadata/purchased_at.
--                  CREATE OR REPLACE public.tg_package_apply_ledger
--                  (bumps revision on every ledger-driven balance
--                  change -- the optimistic-concurrency backbone for
--                  section 26). CREATE OR REPLACE
--                  app.reserve_package_session (same signature, adds a
--                  per-pet eligibility check). DROP+CREATE
--                  app.create_package_invoice (adds trailing p_pet
--                  default null). NEW app.list_customer_package_coverage,
--                  app.renew_customer_package,
--                  app.set_customer_package_status,
--                  app.reconcile_customer_package (read-only),
--                  app.repair_customer_package_balance (guarded write).
-- RLS/Capabilities No table RLS policy changes: every new/changed RPC is
--                  SECURITY DEFINER and re-checks
--                  app.assert_tenant_authorized itself (module
--                  'membership', permission 'membership.read' for
--                  reads, 'membership.manage' for writes -- both already
--                  existing CAPABILITY_KEYS, reused rather than
--                  duplicated). No direct client table grants change.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- SECTION 1 — customer_package_ledger: 'renewal' reason + idempotency key.
-- ---------------------------------------------------------------------
alter table public.customer_package_ledger
  add column request_key uuid;

alter table public.customer_package_ledger
  drop constraint chk_cpl_reason,
  add constraint chk_cpl_reason check (reason in ('purchase','consumption','adjustment','expiry','refund','renewal'));

create unique index uq_cpl_request_key on public.customer_package_ledger (organization_id, request_key) where request_key is not null;

-- ---------------------------------------------------------------------
-- SECTION 2 — packages (catalog): truthful recurrence + per-pet flag.
-- ---------------------------------------------------------------------
alter table public.packages
  add column recurrence_interval text not null default 'none',
  add column per_pet boolean not null default false;

alter table public.packages
  add constraint chk_packages_recurrence_interval check (recurrence_interval in ('none','week','month','year'));

comment on column public.packages.recurrence_interval is
  'Cadence this package is expected to be manually renewed at (section 24). "none" means a one-off, non-recurring package (pre-existing default, unchanged behavior).';
comment on column public.packages.per_pet is
  'When true, a purchase of this package should be scoped to one specific pet via customer_packages.pet_id (section 24).';

-- ---------------------------------------------------------------------
-- SECTION 3 — customer_packages: source invoice, per-pet scope, lifecycle
-- dates, and an optimistic-concurrency revision counter.
-- ---------------------------------------------------------------------
alter table public.customer_packages
  add column source_invoice_id uuid,
  add column pet_id uuid,
  add column activated_at timestamptz,
  add column renewed_at timestamptz,
  add column renewal_count integer not null default 0,
  add column revision integer not null default 1;

alter table public.customer_packages
  add constraint fk_customer_packages_source_invoice foreign key (organization_id, source_invoice_id)
    references public.invoices (organization_id, id),
  add constraint fk_customer_packages_pet foreign key (organization_id, pet_id)
    references public.pets (organization_id, id),
  add constraint chk_customer_packages_renewal_count check (renewal_count >= 0),
  add constraint chk_customer_packages_revision check (revision > 0);

create index idx_customer_packages_source_invoice on public.customer_packages (organization_id, source_invoice_id) where source_invoice_id is not null;
create index idx_customer_packages_pet on public.customer_packages (organization_id, pet_id) where pet_id is not null;

-- Backfill from the pre-existing metadata convention so historical rows are
-- queryable/indexable the same way new ones will be, without changing what
-- they mean.
update public.customer_packages
   set source_invoice_id = (metadata->>'source_invoice_id')::uuid,
       activated_at = coalesce(activated_at, purchased_at)
 where metadata ? 'source_invoice_id' and source_invoice_id is null;
update public.customer_packages
   set activated_at = purchased_at
 where activated_at is null;

comment on column public.customer_packages.source_invoice_id is
  'The invoice that sold/renewed this package. Real FK, replacing the earlier metadata->>''source_invoice_id'' convention (still written for compatibility).';
comment on column public.customer_packages.pet_id is
  'Optional per-pet eligibility scope (section 23/24). Null = any of the customer''s pets, matching the pre-existing service_id null-means-any convention.';
comment on column public.customer_packages.revision is
  'Bumped by every ledger-driven balance change (see tg_package_apply_ledger) and by status/renewal writes. Section 26''s repair path requires the caller to supply the revision it last observed, so a stale read cannot silently overwrite a concurrent change.';

-- ---------------------------------------------------------------------
-- SECTION 4 — ledger-apply trigger also bumps revision (single source of
-- truth for "has anything about this package changed since I read it").
-- ---------------------------------------------------------------------
create or replace function public.tg_package_apply_ledger()
returns trigger language plpgsql as $$
begin
  update public.customer_packages
     set sessions_remaining = sessions_remaining + new.delta,
         revision = revision + 1,
         updated_at = now()
   where id = new.customer_package_id and organization_id = new.organization_id;
  return new;
end; $$;

-- ---------------------------------------------------------------------
-- SECTION 5 — reserve_package_session: same signature, now also enforces
-- per-pet eligibility (section 23/24). Every existing caller (pet_id
-- always null on pre-existing packages) sees identical behavior.
-- ---------------------------------------------------------------------
create or replace function app.reserve_package_session(
  p_line uuid, p_customer_package uuid, p_expires_at timestamptz default null)
returns uuid
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid; ln record; cp record; v_booking_customer uuid; v_avail integer; v_id uuid;
  v_branch uuid; bk public.bookings;
begin
  v_org := app.fn_active_organization();

  select b.id into bk.id
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp
    on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
  join public.bookings b
    on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
  where gjps.organization_id = v_org and gjps.id = p_line and gjps.deleted_at is null;
  if bk.id is null then
    raise exception 'line_not_found' using errcode = 'no_data_found';
  end if;

  select * into bk from public.bookings where id = bk.id for update;
  if bk.status not in ('draft','requested','confirmed','in_progress') then
    raise exception 'booking_not_open_for_assembly:%', bk.status using errcode = 'check_violation';
  end if;

  select gjps.*, gjp.grooming_job_id, gjp.pet_id, b.branch_id as booking_branch_id
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

  perform app.assert_tenant_authorized(v_org, 'scheduling', 'booking.update', v_branch);

  if ln.quantity <> 1 then
    raise exception 'package_requires_unit_quantity' using errcode = 'check_violation';
  end if;

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
  if cp.service_id is not null and cp.service_id <> ln.service_id then
    raise exception 'package_not_applicable_to_service' using errcode = 'check_violation';
  end if;
  -- Per-pet eligibility (section 23/24): a package scoped to one pet cannot
  -- back a session for a different pet, even within the same customer.
  if cp.pet_id is not null and cp.pet_id <> ln.pet_id then
    raise exception 'package_not_applicable_to_pet' using errcode = 'check_violation';
  end if;
  select b.customer_id into v_booking_customer
  from public.bookings b
  where b.organization_id = v_org and b.id = ln.grooming_job_id;
  if v_booking_customer is null or v_booking_customer <> cp.customer_id then
    raise exception 'package_customer_mismatch' using errcode = 'check_violation';
  end if;

  perform app.expire_package_reservations(p_customer_package);

  v_avail := app.fn_package_available_sessions(v_org, p_customer_package);
  if v_avail <= 0 then
    raise exception 'no_sessions_available' using errcode = 'check_violation';
  end if;

  insert into public.package_reservations
    (organization_id, customer_package_id, grooming_job_pet_service_id, status, expires_at)
  values (v_org, p_customer_package, p_line, 'reserved', p_expires_at)
  returning id into v_id;

  return v_id;
end; $$;

-- ---------------------------------------------------------------------
-- SECTION 6 — create_package_invoice: same behavior, plus an optional
-- p_pet to scope the sold package to one pet, plus writing the new real
-- source_invoice_id/activated_at columns (metadata kept for compatibility).
-- Dropped and recreated (not create-or-replace) because the parameter
-- list changes; the new signature is a strict superset so every existing
-- caller (which never passes p_pet) is unaffected -- Postgres fills the
-- default.
-- ---------------------------------------------------------------------
drop function if exists app.create_package_invoice(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid);

create function app.create_package_invoice(
  p_branch uuid, p_customer uuid, p_package uuid, p_issued_at timestamptz, p_due_at timestamptz,
  p_admin_notes text, p_request_key uuid, p_pet uuid default null)
returns public.invoices language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_pkg public.packages; v_order public.orders; v_invoice public.invoices; v_cp uuid; v_number text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_module('membership')
     or not app.has_permission('invoice.issue') or not app.has_permission('membership.manage') or not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_request_key is null or p_issued_at is null or (p_due_at is not null and p_due_at<p_issued_at) then raise exception 'invalid_invoice_details' using errcode='22023'; end if;
  select * into v_invoice from public.invoices where organization_id=v_org and request_key=p_request_key;
  if found then return v_invoice; end if;
  if not exists(select 1 from public.customers where organization_id=v_org and id=p_customer and deleted_at is null) then raise exception 'customer_not_found' using errcode='P0002'; end if;
  select * into v_pkg from public.packages where organization_id=v_org and id=p_package and is_active and deleted_at is null;
  if not found then raise exception 'package_not_found' using errcode='P0002'; end if;
  if p_pet is not null and not exists(select 1 from public.pets where organization_id=v_org and id=p_pet and customer_id=p_customer and deleted_at is null) then
    raise exception 'pet_not_found_for_customer' using errcode='P0002'; end if;
  if v_pkg.per_pet and p_pet is null then raise exception 'pet_required_for_package' using errcode='22023'; end if;
  insert into public.orders(organization_id,branch_id,customer_id,status,currency,metadata)
  values(v_org,p_branch,p_customer,'confirmed',v_pkg.currency,jsonb_build_object('billing_mode','package_sale','request_key',p_request_key)) returning * into v_order;
  insert into public.order_items(organization_id,order_id,item_type,package_id,name_snapshot,quantity,unit_price,line_total,pricing_breakdown,metadata)
  values(v_org,v_order.id,'package',v_pkg.id,v_pkg.name,1,v_pkg.price,v_pkg.price,jsonb_build_object('sessions',v_pkg.total_sessions,'validity_days',v_pkg.validity_days),jsonb_build_object('source','package_catalog'));
  select * into v_order from public.orders where id=v_order.id;
  v_number:='PKG-'||to_char(p_issued_at at time zone 'Asia/Jakarta','YYYYMMDD')||'-'||upper(substr(replace(p_request_key::text,'-',''),1,8));
  insert into public.invoices(organization_id,branch_id,customer_id,order_id,invoice_number,status,currency,subtotal,discount_total,tax_total,total,issued_at,due_at,billing_mode,document_type,admin_notes,request_key,metadata)
  values(v_org,p_branch,p_customer,v_order.id,v_number,'issued',v_order.currency,v_order.subtotal,v_order.discount_total,v_order.tax_total,v_order.total,p_issued_at,p_due_at,'package_sale','invoice',left(nullif(trim(p_admin_notes),''),2000),p_request_key,jsonb_build_object('package_id',v_pkg.id)) returning * into v_invoice;
  insert into public.invoice_lines(organization_id,invoice_id,item_type,package_id,name_snapshot,quantity,unit_price,line_total,pricing_breakdown)
  values(v_org,v_invoice.id,'package',v_pkg.id,v_pkg.name,1,v_pkg.price,v_pkg.price,jsonb_build_object('sessions',v_pkg.total_sessions,'validity_days',v_pkg.validity_days));
  insert into public.customer_packages(organization_id,customer_id,package_id,service_id,pet_id,sessions_remaining,purchased_at,activated_at,source_invoice_id,expires_at,status,source_ref,metadata)
  values(v_org,p_customer,v_pkg.id,v_pkg.service_id,p_pet,0,p_issued_at,p_issued_at,v_invoice.id,case when v_pkg.validity_days is null then null else p_issued_at+(v_pkg.validity_days||' days')::interval end,'active',v_number,jsonb_build_object('source_invoice_id',v_invoice.id)) returning id into v_cp;
  insert into public.customer_package_ledger(organization_id,customer_package_id,delta,reason,notes)
  values(v_org,v_cp,v_pkg.total_sessions,'purchase','Invoice '||v_number);
  return v_invoice;
end $$;

revoke all on function app.create_package_invoice(uuid,uuid,uuid,timestamptz,timestamptz,text,uuid,uuid) from public;
grant execute on function app.create_package_invoice(uuid,uuid,uuid,timestamptz,timestamptz,text,uuid,uuid) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 7 — list_customer_package_coverage: batched available-vs-
-- reserved balance for the booking wizard / Customer 360 (section 23).
-- ---------------------------------------------------------------------
create or replace function app.list_customer_package_coverage(p_customer uuid)
returns table(
  customer_package_id uuid, package_id uuid, package_name text, service_id uuid, pet_id uuid,
  sessions_remaining integer, reserved_sessions integer, available_sessions integer,
  expires_at timestamptz, status text
)
security definer set search_path = app, public
language plpgsql stable as $$
declare v_org uuid;
begin
  v_org := app.fn_active_organization();
  if not exists (select 1 from public.customers where organization_id = v_org and id = p_customer) then
    raise exception 'customer_not_found' using errcode = 'no_data_found';
  end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.read');
  return query
  select cp.id, cp.package_id, p.name, cp.service_id, cp.pet_id, cp.sessions_remaining,
         coalesce((select count(*)::int from public.package_reservations pr
                   where pr.organization_id = v_org and pr.customer_package_id = cp.id and pr.status = 'reserved'), 0),
         cp.sessions_remaining - coalesce((select count(*)::int from public.package_reservations pr
                   where pr.organization_id = v_org and pr.customer_package_id = cp.id and pr.status = 'reserved'), 0),
         cp.expires_at, cp.status
  from public.customer_packages cp
  join public.packages p on p.organization_id = cp.organization_id and p.id = cp.package_id
  where cp.organization_id = v_org and cp.customer_id = p_customer and cp.status = 'active'
    and (cp.expires_at is null or cp.expires_at > now())
  order by cp.expires_at nulls last;
end; $$;

revoke all on function app.list_customer_package_coverage(uuid) from public, authenticated;
grant execute on function app.list_customer_package_coverage(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 8 — renew_customer_package: manual, ledger-backed renewal
-- (section 24). No scheduler, no automatic charging: a staff action.
-- ---------------------------------------------------------------------
create or replace function app.renew_customer_package(p_customer_package uuid, p_request_key uuid)
returns public.customer_packages
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid; cp public.customer_packages; pkg public.packages; v_new_expiry timestamptz; v_interval interval;
begin
  v_org := app.fn_active_organization();
  if p_request_key is null then raise exception 'request_key_required' using errcode = 'check_violation'; end if;
  if exists (select 1 from public.customer_package_ledger where organization_id = v_org and request_key = p_request_key) then
    select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
    if found then return cp; end if;
  end if;
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.manage');
  if cp.status = 'canceled' then raise exception 'package_canceled_cannot_renew' using errcode = 'check_violation'; end if;
  select * into pkg from public.packages where organization_id = v_org and id = cp.package_id;
  if not found or not pkg.is_active then raise exception 'package_catalog_inactive' using errcode = 'check_violation'; end if;
  v_interval := case pkg.recurrence_interval
    when 'week' then interval '7 days'
    when 'month' then interval '1 month'
    when 'year' then interval '1 year'
    else (coalesce(pkg.validity_days, 30) || ' days')::interval
  end;
  v_new_expiry := greatest(now(), coalesce(cp.expires_at, now())) + v_interval;
  update public.customer_packages
     set status = 'active', expires_at = v_new_expiry, renewed_at = now(), renewal_count = renewal_count + 1
   where id = cp.id;
  insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes, request_key)
  values (v_org, cp.id, pkg.total_sessions, 'renewal', 'Manual renewal ('||pkg.recurrence_interval||')', p_request_key);
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  return cp;
end; $$;

revoke all on function app.renew_customer_package(uuid, uuid) from public, authenticated;
grant execute on function app.renew_customer_package(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 9 — set_customer_package_status: guarded archive (section 25).
-- Refuses to cancel a package with any outstanding 'reserved' session.
-- ---------------------------------------------------------------------
create or replace function app.set_customer_package_status(p_customer_package uuid, p_status text, p_reason text default null)
returns public.customer_packages
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid; cp public.customer_packages; v_active_reservations integer;
begin
  v_org := app.fn_active_organization();
  if p_status not in ('active', 'canceled') then
    raise exception 'invalid_status:%', p_status using errcode = 'check_violation';
  end if;
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.manage');
  if p_status = 'canceled' then
    select count(*) into v_active_reservations from public.package_reservations
     where organization_id = v_org and customer_package_id = p_customer_package and status = 'reserved';
    if v_active_reservations > 0 then
      raise exception 'package_has_active_reservations' using errcode = 'check_violation';
    end if;
  end if;
  update public.customer_packages
     set status = p_status, revision = revision + 1,
         metadata = metadata || jsonb_build_object('status_reason', p_reason, 'status_changed_at', now())
   where id = cp.id;
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  return cp;
end; $$;

revoke all on function app.set_customer_package_status(uuid, text, text) from public, authenticated;
grant execute on function app.set_customer_package_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 10 — reconcile_customer_package: READ-ONLY recomputation
-- (section 26). Never writes. Compares the cached balance against the
-- immutable ledger sum and cross-checks reservation vs consumption
-- counts; a mismatch is only ever possible if something wrote to
-- customer_packages.sessions_remaining outside the ledger trigger.
-- ---------------------------------------------------------------------
create or replace function app.reconcile_customer_package(p_customer_package uuid)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid; cp public.customer_packages; v_ledger_balance numeric;
  v_reserved integer; v_consumed_reservations integer; v_consumed_ledger integer;
begin
  v_org := app.fn_active_organization();
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.read');
  select coalesce(sum(delta), 0) into v_ledger_balance
    from public.customer_package_ledger where organization_id = v_org and customer_package_id = p_customer_package;
  select count(*) into v_reserved from public.package_reservations
   where organization_id = v_org and customer_package_id = p_customer_package and status = 'reserved';
  select count(*) into v_consumed_reservations from public.package_reservations
   where organization_id = v_org and customer_package_id = p_customer_package and status = 'consumed';
  select count(*) into v_consumed_ledger from public.customer_package_ledger
   where organization_id = v_org and customer_package_id = p_customer_package and reason = 'consumption';
  return jsonb_build_object(
    'customer_package_id', cp.id, 'revision', cp.revision, 'status', cp.status,
    'cached_balance', cp.sessions_remaining, 'ledger_balance', v_ledger_balance,
    'balance_matches', cp.sessions_remaining = v_ledger_balance,
    'reserved_count', v_reserved, 'consumed_reservations', v_consumed_reservations,
    'consumption_ledger_entries', v_consumed_ledger,
    'reservation_consumption_matches', v_consumed_reservations = v_consumed_ledger,
    'checked_at', now());
end; $$;

revoke all on function app.reconcile_customer_package(uuid) from public, authenticated;
grant execute on function app.reconcile_customer_package(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 11 — repair_customer_package_balance: the guarded, separately
-- authorized write (section 26). Locks the row, re-checks the caller-
-- supplied revision against the CURRENT row (rejects a stale request).
--
-- Why a direct resync, not a compensating ledger delta: sessions_remaining
-- is defined as sum(customer_package_ledger.delta) for this package (that
-- is the whole point of tg_package_apply_ledger). If the cache ever
-- disagrees with that sum, it can only be because something wrote to
-- sessions_remaining OUTSIDE the ledger. Appending ONE MORE delta equal to
-- (ledger_sum - cached) does NOT fix that: the new row changes ledger_sum
-- by the same amount it changes the cache, so the gap this function was
-- called to close is mathematically preserved forever, just shifted --
-- reconcile_customer_package would report a mismatch again immediately.
-- The only fix that actually converges is to set the cache TO the ledger
-- sum directly (the ledger is the source of truth; trust it, don't add to
-- it) and record what happened as an audit event, not as a delta.
-- Idempotent via p_request_key, recorded in timeline_events (its own
-- unique-per-org index is not needed here since the guard below is a
-- lookup, not an insert-constraint).
-- ---------------------------------------------------------------------
create or replace function app.repair_customer_package_balance(p_customer_package uuid, p_revision integer, p_request_key uuid)
returns public.customer_packages
security definer set search_path = app, public
language plpgsql as $$
declare v_org uuid; cp public.customer_packages; v_ledger_balance numeric;
begin
  v_org := app.fn_active_organization();
  if p_request_key is null then raise exception 'request_key_required' using errcode = 'check_violation'; end if;
  if exists (select 1 from public.timeline_events where organization_id = v_org and subject_type = 'package'
             and subject_id = p_customer_package and event_type = 'membership.balance_repaired' and data->>'request_key' = p_request_key::text) then
    select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
    if found then return cp; end if;
  end if;
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  -- Distinct, explicit authorization for the WRITE path (reconcile_customer_package
  -- only requires membership.read; repairing requires membership.manage).
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.manage');
  if cp.revision <> p_revision then
    raise exception 'stale_repair_request' using errcode = '40001';
  end if;
  select coalesce(sum(delta), 0) into v_ledger_balance
    from public.customer_package_ledger where organization_id = v_org and customer_package_id = p_customer_package;
  if v_ledger_balance <> cp.sessions_remaining then
    update public.customer_packages set sessions_remaining = v_ledger_balance, revision = revision + 1 where id = cp.id;
  end if;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'package', p_customer_package, app.fn_current_user_id(), 'membership.balance_repaired', 'membership.balance_repaired',
          jsonb_build_object('request_key', p_request_key, 'cached_before', cp.sessions_remaining, 'ledger_balance', v_ledger_balance));
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  return cp;
end; $$;

revoke all on function app.repair_customer_package_balance(uuid, integer, uuid) from public, authenticated;
grant execute on function app.repair_customer_package_balance(uuid, integer, uuid) to authenticated;

commit;
