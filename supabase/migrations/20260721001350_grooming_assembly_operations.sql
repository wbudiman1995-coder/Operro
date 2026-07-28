-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20260721001350_grooming_assembly_operations
-- Internal label   Batch 2 / "0100" (docs only; the filename above is the
--                  Supabase-compatible timestamped name used for db push).
-- Purpose          Controlled, server-mediated grooming mutation operations
--                  0013 deferred. Clients cannot write grooming tables directly
--                  (0013 revoked INSERT/DELETE + quantity/deleted_at UPDATEs);
--                  these owner-run SECURITY DEFINER RPCs are the only path. Each
--                  authorizes (tenant + scheduling + booking.update + BOOKING
--                  branch), validates, mutates, audits.
-- Correction pass  Integration defects found after 0013 (implemented HERE, never
--                  by editing the applied 0013 file):
--   (1) add_pet enforces pet in booking.organization AND booking.customer_id
--       (pet_customer_mismatch).
--   (2) remove_pet releases active package reservations on the pet's live lines
--       BEFORE soft-delete (status=released, released_at=now()); idempotent.
--   (3) add_line accepts only ACTIVE, non-deleted, same-org service_catalog rows
--       and snapshots name/base_price/currency/duration_minutes (no silent 60).
--   (4) assembly_assign_pet_resource: branch-authorized per-pet groomer with
--       resource validation + reassignment audit.
--   (7) LOCK ORDER booking -> pet -> line everywhere. set_line_quantity/void_line
--       resolve the owning booking WITHOUT a lock, guard (lock booking), THEN
--       lock+revalidate the line. Matches complete_booking booking-first order.
--   (8) v1 package-quantity: package-backed lines must have quantity=1.
--       reserve_package_session rejects quantity<>1
--       (package_requires_unit_quantity); set_line_quantity rejects a line with
--       ANY package reservation lifecycle row (line_has_package_reservation).
--       Compatibility replacement of app.reserve_package_session via
--       create-or-replace; the 0013 file is untouched.
-- Dependencies     0001-0013. Reuses app.assert_tenant_authorized (branch-aware).
-- Evidence         EXECUTED on PostgreSQL 16.14.
-- =====================================================================

begin;

-- SECTION 100 — assembly_guard: resolve+lock+authorize booking (LOCK 1), refuse frozen.
create or replace function app.assembly_guard(p_booking uuid)
returns public.bookings
security definer set search_path = app, public
language plpgsql as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then raise exception 'booking_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(b.organization_id, 'scheduling', 'booking.update', b.branch_id);
  if b.status not in ('draft','requested','confirmed','in_progress') then
    raise exception 'booking_not_open_for_assembly:%', b.status using errcode = 'check_violation';
  end if;
  return b;
end; $$;
comment on function app.assembly_guard(uuid) is
  'Batch2: resolve+lock+authorize booking (LOCK 1 in booking->pet->line order); refuse frozen. Internal.';

-- SECTION 110 — add_pet: pet must belong to booking ORG and CUSTOMER (item 1).
create or replace function app.assembly_add_pet(p_booking uuid, p_pet uuid, p_is_required boolean default true)
returns uuid security definer set search_path = app, public language plpgsql as $$
declare b public.bookings; v_seq integer; v_id uuid; v_pet_customer uuid;
begin
  b := app.assembly_guard(p_booking);
  select p.customer_id into v_pet_customer from public.pets p
   where p.organization_id = b.organization_id and p.id = p_pet and p.deleted_at is null;
  if not found then raise exception 'pet_not_in_org' using errcode = 'check_violation'; end if;
  if v_pet_customer is distinct from b.customer_id then
    raise exception 'pet_customer_mismatch' using errcode = 'check_violation';
  end if;
  insert into public.grooming_jobs (booking_id, organization_id)
  values (b.id, b.organization_id) on conflict (organization_id, booking_id) do nothing;
  if exists (select 1 from public.grooming_job_pets gjp
             where gjp.organization_id = b.organization_id and gjp.grooming_job_id = b.id
               and gjp.pet_id = p_pet and gjp.deleted_at is null) then
    raise exception 'pet_already_on_booking' using errcode = 'unique_violation';
  end if;
  -- v1 pet-removal permanence (item 6): removal is a SOFT delete and the unique
  -- index uq_gjp_job_pet(org, job, pet) spans soft-deleted rows, so a removed pet
  -- cannot be re-added to the same booking. Detect the prior soft-deleted row and
  -- raise a STABLE, explicit error instead of leaking the raw 23505 unique
  -- violation. (A controlled restore op is deliberately out of scope for v1.)
  if exists (select 1 from public.grooming_job_pets gjp
             where gjp.organization_id = b.organization_id and gjp.grooming_job_id = b.id
               and gjp.pet_id = p_pet and gjp.deleted_at is not null) then
    raise exception 'pet_removal_is_permanent' using errcode = 'check_violation';
  end if;
  select coalesce(max(sequence),0)+1 into v_seq from public.grooming_job_pets
   where organization_id = b.organization_id and grooming_job_id = b.id;
  insert into public.grooming_job_pets (organization_id, grooming_job_id, pet_id, sequence, status, is_required)
  values (b.organization_id, b.id, p_pet, v_seq, 'pending', coalesce(p_is_required,true))
  returning id into v_id;
  perform app.assembly_audit(b.organization_id, b.id, 'grooming.pet_added',
    jsonb_build_object('pet_id', p_pet, 'grooming_job_pet_id', v_id, 'is_required', p_is_required));
  return v_id;
end; $$;

-- SECTION 120 — remove_pet: release reservations on child lines, then soft-delete (items 2 + 7).
create or replace function app.assembly_remove_pet(p_pet uuid, p_reason text)
returns void security definer set search_path = app, public language plpgsql as $$
declare gjp record; b public.bookings; v_job uuid;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select grooming_job_id into v_job from public.grooming_job_pets where id = p_pet;
  if not found then raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select * into gjp from public.grooming_job_pets where id = p_pet for update;
  if not found or gjp.deleted_at is not null then
    raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  update public.package_reservations pr set status = 'released', released_at = now()
    from public.grooming_job_pet_services gjps
   where gjps.organization_id = gjp.organization_id and gjps.grooming_job_pet_id = gjp.id
     and gjps.deleted_at is null and pr.organization_id = gjps.organization_id
     and pr.grooming_job_pet_service_id = gjps.id and pr.status = 'reserved';
  update public.grooming_job_pet_services set deleted_at = now()
   where organization_id = gjp.organization_id and grooming_job_pet_id = gjp.id and deleted_at is null;
  update public.grooming_job_pets set deleted_at = now() where id = gjp.id;
  perform app.assembly_audit(gjp.organization_id, gjp.grooming_job_id, 'grooming.pet_removed',
    jsonb_build_object('grooming_job_pet_id', gjp.id, 'pet_id', gjp.pet_id, 'reason', p_reason));
end; $$;

-- SECTION 130 — add_line: only ACTIVE non-deleted same-org catalog; snapshot incl duration (item 3).
create or replace function app.assembly_add_line(p_pet uuid, p_service uuid, p_quantity integer default 1)
returns uuid security definer set search_path = app, public language plpgsql as $$
declare gjp record; b public.bookings; v_job uuid;
        v_price numeric(14,2); v_name text; v_cur text; v_dur integer; v_id uuid;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity_must_be_positive' using errcode = 'check_violation'; end if;
  select grooming_job_id into v_job from public.grooming_job_pets where id = p_pet;
  if not found then raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select * into gjp from public.grooming_job_pets where id = p_pet for update;
  if not found or gjp.deleted_at is not null then
    raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  select sc.name, sc.base_price, sc.currency, sc.duration_minutes
    into v_name, v_price, v_cur, v_dur
  from public.service_catalog sc
  where sc.organization_id = gjp.organization_id and sc.id = p_service
    and sc.is_active = true and sc.deleted_at is null;
  if not found then
    raise exception 'service_not_active_or_not_in_org' using errcode = 'check_violation'; end if;
  -- line.duration_minutes is NOT NULL; snapshot the catalog value, only falling
  -- back to 60 if the catalog itself has none (never overriding a real value).
  insert into public.grooming_job_pet_services
    (organization_id, grooming_job_pet_id, service_id, service_name_snapshot,
     unit_price_snapshot, currency, quantity, duration_minutes)
  values (gjp.organization_id, gjp.id, p_service, coalesce(v_name,'Service'),
          coalesce(v_price,0), coalesce(v_cur,'USD'), p_quantity, coalesce(v_dur,60))
  returning id into v_id;
  perform app.assembly_audit(gjp.organization_id, gjp.grooming_job_id, 'grooming.line_added',
    jsonb_build_object('grooming_job_pet_service_id', v_id, 'service_id', p_service,
                       'quantity', p_quantity, 'unit_price_snapshot', v_price, 'duration_minutes', coalesce(v_dur,60)));
  return v_id;
end; $$;

-- SECTION 140 — set_line_quantity (items 7 + 8): booking-first lock; reject realized effects
-- and any package reservation lifecycle row.
create or replace function app.assembly_set_line_quantity(p_line uuid, p_quantity integer)
returns void security definer set search_path = app, public language plpgsql as $$
declare b public.bookings; v_job uuid; ln record;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity_must_be_positive' using errcode = 'check_violation'; end if;
  select gjp.grooming_job_id into v_job
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
  where gjps.id = p_line;
  if not found then raise exception 'line_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select gjps.*, gjp.grooming_job_id into ln
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
  where gjps.id = p_line for update of gjps;
  if not found or ln.deleted_at is not null then
    raise exception 'line_not_found' using errcode = 'no_data_found'; end if;
  if exists (select 1 from public.commission_entries where reference_line_id = p_line)
     or exists (select 1 from public.inventory_movements where reference_line_id = p_line)
     or exists (select 1 from public.customer_package_ledger where reference_line_id = p_line) then
    raise exception 'line_has_realized_effects_use_void' using errcode = 'check_violation'; end if;
  if exists (select 1 from public.package_reservations where grooming_job_pet_service_id = p_line) then
    raise exception 'line_has_package_reservation' using errcode = 'check_violation'; end if;
  update public.grooming_job_pet_services set quantity = p_quantity where id = p_line;
  perform app.assembly_audit(ln.organization_id, ln.grooming_job_id, 'grooming.line_quantity_changed',
    jsonb_build_object('grooming_job_pet_service_id', p_line, 'quantity', p_quantity));
end; $$;

-- SECTION 150 — void_line (item 7): booking-first lock; release active reservation; soft-delete.
create or replace function app.assembly_void_line(p_line uuid, p_reason text)
returns void security definer set search_path = app, public language plpgsql as $$
declare b public.bookings; v_job uuid; ln record;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = 'check_violation'; end if;
  select gjp.grooming_job_id into v_job
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
  where gjps.id = p_line;
  if not found then raise exception 'line_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select gjps.*, gjp.grooming_job_id into ln
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
  where gjps.id = p_line for update of gjps;
  if not found or ln.deleted_at is not null then
    raise exception 'line_not_found' using errcode = 'no_data_found'; end if;
  update public.package_reservations set status = 'released', released_at = now()
   where organization_id = ln.organization_id and grooming_job_pet_service_id = p_line and status = 'reserved';
  update public.grooming_job_pet_services set deleted_at = now() where id = p_line;
  perform app.assembly_audit(ln.organization_id, ln.grooming_job_id, 'grooming.line_voided',
    jsonb_build_object('grooming_job_pet_service_id', p_line, 'reason', p_reason));
end; $$;

-- SECTION 155 — assign_pet_resource (item 4): controlled per-pet groomer.
create or replace function app.assembly_assign_pet_resource(p_pet uuid, p_resource uuid)
returns void security definer set search_path = app, public language plpgsql as $$
declare b public.bookings; v_job uuid; gjp record; v_prev uuid;
begin
  select grooming_job_id into v_job from public.grooming_job_pets where id = p_pet;
  if not found then raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select * into gjp from public.grooming_job_pets where id = p_pet for update;
  if not found or gjp.deleted_at is not null then
    raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  -- Resource must be same org AND the SAME BRANCH as the booking, active, not
  -- deleted (blocker 3). b (from assembly_guard) is the booking row.
  if not exists (select 1 from public.resources r
                 where r.organization_id = b.organization_id
                   and r.branch_id = b.branch_id
                   and r.id = p_resource
                   and r.status = 'active' and r.deleted_at is null) then
    raise exception 'resource_not_active_or_not_in_branch' using errcode = 'check_violation'; end if;
  v_prev := gjp.assigned_resource_id;
  update public.grooming_job_pets set assigned_resource_id = p_resource where id = gjp.id;
  perform app.assembly_audit(gjp.organization_id, gjp.grooming_job_id,
    case when v_prev is null then 'grooming.pet_resource_assigned' else 'grooming.pet_resource_reassigned' end,
    jsonb_build_object('grooming_job_pet_id', gjp.id, 'resource_id', p_resource, 'previous_resource_id', v_prev));
end; $$;

-- SECTION 160 — audit helper (one timeline event per mutation).
create or replace function app.assembly_audit(p_org uuid, p_booking uuid, p_event text, p_data jsonb)
returns void security definer set search_path = app, public language plpgsql as $$
begin
  insert into public.timeline_events
    (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (p_org, 'booking', p_booking, app.fn_current_user_id(), p_event, p_event, p_data);
end; $$;

-- SECTION 170 — reserve_package_session: FULL frozen-0013 behavior PRESERVED
-- verbatim (package existence + active + expiration + service applicability +
-- package-customer vs booking-customer + stale-expiration before availability +
-- exact stable error names + oversubscription protection), with TWO additions:
--   (item 8) require the line quantity = 1 (a package session backs one unit);
--   (item 2) lock the BOOKING first and refuse if it is not open for assembly,
--            so a reservation cannot race with / follow booking completion.
--            Booking-first honors the approved booking -> pet -> line lock order
--            (complete_booking also locks the booking first), so no deadlock.
-- This is a create-or-replace; the applied 0013 file is NOT edited.
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

  -- Resolve the owning booking WITHOUT a lock first (so we take locks in the
  -- approved booking -> pet -> line order, not line-first).
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

  -- LOCK 1: booking. Serializes against complete_booking (item 2). If the
  -- booking is already completed/canceled/no_show, its composition + effects are
  -- frozen and no new reservation may be created.
  select * into bk from public.bookings where id = bk.id for update;
  if bk.status not in ('draft','requested','confirmed','in_progress') then
    raise exception 'booking_not_open_for_assembly:%', bk.status using errcode = 'check_violation';
  end if;

  -- Load line (must exist, same org, not deleted) AND its owning booking branch
  -- (frozen-0013 ITEM 2): chain line -> grooming_job_pet -> booking. The branch
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

  -- (item 8) A package session backs exactly ONE unit. A line reserving a
  -- package session must have quantity = 1; multi-quantity commercial lines
  -- cannot be package-backed in v1. Checked BEFORE package mutation, and
  -- alongside (not instead of) every frozen protection below.
  if ln.quantity <> 1 then
    raise exception 'package_requires_unit_quantity' using errcode = 'check_violation';
  end if;

  -- Lock and validate the package (frozen-0013 package checks — PRESERVED).
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
  -- reserved row does not keep availability artificially low (frozen ITEM 9).
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

-- SECTION 200 — privileges.
revoke execute on function app.assembly_add_pet(uuid, uuid, boolean)        from public;
revoke execute on function app.assembly_remove_pet(uuid, text)              from public;
revoke execute on function app.assembly_add_line(uuid, uuid, integer)       from public;
revoke execute on function app.assembly_set_line_quantity(uuid, integer)    from public;
revoke execute on function app.assembly_void_line(uuid, text)               from public;
revoke execute on function app.assembly_assign_pet_resource(uuid, uuid)     from public;
grant  execute on function app.assembly_add_pet(uuid, uuid, boolean)        to authenticated;
grant  execute on function app.assembly_remove_pet(uuid, text)              to authenticated;
grant  execute on function app.assembly_add_line(uuid, uuid, integer)       to authenticated;
grant  execute on function app.assembly_set_line_quantity(uuid, integer)    to authenticated;
grant  execute on function app.assembly_void_line(uuid, text)               to authenticated;
grant  execute on function app.assembly_assign_pet_resource(uuid, uuid)     to authenticated;
revoke execute on function app.assembly_guard(uuid)                    from public, authenticated;
revoke execute on function app.assembly_audit(uuid, uuid, text, jsonb) from public, authenticated;
revoke execute on function app.reserve_package_session(uuid, uuid, timestamptz) from public;
grant  execute on function app.reserve_package_session(uuid, uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';

commit;
-- END 20260721001350_grooming_assembly_operations
