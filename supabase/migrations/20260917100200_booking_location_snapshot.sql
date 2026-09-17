-- =====================================================================
-- Immutable home-service booking location + a dispatch-stage overlay.
--
-- address_snapshot is the source of truth once a booking exists: it is
-- written once at booking-creation time and never re-derived from the
-- customer's current saved address, so editing or deleting that address
-- later cannot silently change a past or upcoming booking's location.
-- customer_address_id is kept only as a soft, nullable pointer back to
-- the saved address (for "based on your saved address" convenience UI);
-- it is set null on delete rather than blocking the delete, per Rule 18
-- (snapshot at txn time) already used for service_name_snapshot/price_snapshot.
--
-- dispatch_stage is deliberately NOT a new `bookings.status` value: the
-- status state machine (app.transition_booking_status / app.complete_booking)
-- is frozen and stays the sole authority over draft/requested/confirmed/
-- in_progress/completed/canceled/no_show. dispatch_stage is an additional,
-- home-service-only overlay a groomer/dispatcher can update independently
-- while the real status is still 'confirmed' or 'in_progress' — it carries
-- no authority of its own and is ignored entirely for in-store bookings.
-- =====================================================================

alter table public.bookings
  add column customer_address_id uuid,
  add column address_snapshot jsonb,
  add column travel_fee numeric(14,2),
  add column travel_minutes_snapshot integer,
  add column service_area_matched boolean,
  add column dispatch_stage text;

alter table public.bookings
  add constraint fk_bookings_customer_address foreign key (organization_id, customer_address_id)
    references public.customer_addresses (organization_id, id) on delete set null,
  add constraint chk_bookings_dispatch_stage
    check (dispatch_stage is null or dispatch_stage in ('scheduled','en_route','arrived','in_service'));

create index idx_bookings_customer_address on public.bookings (customer_address_id) where customer_address_id is not null;

-- The frozen schema's INSERT grant on public.bookings is an explicit column list (not a
-- table-level grant), so it does not automatically extend to new columns the way SELECT
-- does. Without this, the booking server action's direct .insert() of these six columns
-- fails with "permission denied for table bookings" for the authenticated role — caught by
-- running a real authenticated-role insert against local Postgres, not by typecheck.
grant insert (customer_address_id, address_snapshot, travel_fee, travel_minutes_snapshot, service_area_matched, dispatch_stage)
  on public.bookings to authenticated;

comment on column public.bookings.address_snapshot is
  'Immutable: full formatted address, coordinates, recipient contact, landmark and access notes at booking time. Never re-derived from customer_addresses after creation.';
comment on column public.bookings.dispatch_stage is
  'Home-service-only progress overlay (scheduled/en_route/arrived/in_service), independent of and subordinate to bookings.status. Null for in-store bookings.';

-- Sets the dispatch stage for a home-service booking. Deliberately separate
-- from app.transition_booking_status: it never touches `status`, so it
-- cannot be used to bypass the real state machine, and it is blocked once
-- a booking is completed/canceled/no_show (nothing left to dispatch).
create or replace function app.fn_set_dispatch_stage(p_booking uuid, p_stage text)
returns void
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_org uuid := app.fn_active_organization();
  v_status text;
  v_fulfillment text;
begin
  if not app.has_permission('booking.update') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_stage not in ('scheduled','en_route','arrived','in_service') then
    raise exception 'invalid_dispatch_stage' using errcode = '22023';
  end if;

  select status, fulfillment_mode into v_status, v_fulfillment
  from public.bookings
  where id = p_booking and organization_id = v_org;

  if v_status is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;
  if v_fulfillment <> 'home' then
    raise exception 'not_a_home_booking' using errcode = '22023';
  end if;
  if v_status in ('completed','canceled','no_show') then
    raise exception 'booking_already_closed' using errcode = '22023';
  end if;

  update public.bookings set dispatch_stage = p_stage where id = p_booking and organization_id = v_org;
end;
$$;
revoke all on function app.fn_set_dispatch_stage(uuid, text) from public;
grant execute on function app.fn_set_dispatch_stage(uuid, text) to authenticated;
