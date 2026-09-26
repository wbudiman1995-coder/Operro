-- Section 30 — visit register.
--
-- Operro deliberately has ONE authoritative scheduling entity (public.bookings);
-- see apps/web/src/app/customers/[customerId]/page.tsx:9-11. This migration does
-- NOT reintroduce a parallel visit/appointment duality. "Automatic visit history"
-- is a read-side projection over completed bookings, built in application code
-- (apps/web/src/lib/visit-register.ts) exactly like loadOperationsWorkspace /
-- loadInvoiceStudioData already project bookings — no view or table is added for
-- that half of the requirement.
--
-- What genuinely does not exist yet, and is additive here, is the OFF-BOOKS case:
-- a real visit that never went through the booking calendar (walk-in paid in cash,
-- historical backfill) plus the separate "manually billed" bookkeeping state that
-- both a manual visit and a completed booking can carry instead of, or before, a
-- formal invoice.
begin;

-- New subject_type for the generic attachments/timeline registry (ADR-002 §3.5:
-- a new domain attaches with a data row, zero schema change).
insert into public.subject_types (key, description) values
  ('manual_visit','Manual (off-books) visit')
on conflict (key) do nothing;

-- =====================================================================
-- manual_visits — off-books visit records, never a substitute for a booking.
-- =====================================================================
create table public.manual_visits (
  id               uuid          not null default app.fn_uuid_v7(),
  organization_id  uuid          not null,
  branch_id        uuid          not null,
  customer_id      uuid          not null,
  pet_id           uuid,
  fulfillment_mode text          not null default 'in_store',
  visit_at         timestamptz   not null,
  description      text          not null,
  note             text,
  invoice_id       uuid,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  created_by       uuid,
  updated_by       uuid,
  deleted_at       timestamptz,
  constraint pk_manual_visits primary key (id),
  constraint uq_manual_visits_org_id unique (organization_id, id),
  constraint fk_manual_visits_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_manual_visits_branches foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint fk_manual_visits_customers foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint fk_manual_visits_pets foreign key (organization_id, pet_id) references public.pets (organization_id, id),
  constraint fk_manual_visits_invoices foreign key (organization_id, invoice_id) references public.invoices (organization_id, id),
  constraint chk_manual_visits_fulfillment check (fulfillment_mode in ('in_store','home','pickup_delivery')),
  constraint chk_manual_visits_description check (length(trim(description)) > 0)
);
create index idx_manual_visits_org_customer on public.manual_visits (organization_id, customer_id);
create index idx_manual_visits_org_visit_at on public.manual_visits (organization_id, visit_at);

create trigger trg_manual_visits_updated_at before update on public.manual_visits
  for each row execute function app.tg_set_updated_at();
create trigger trg_manual_visits_audit_cols before insert or update on public.manual_visits
  for each row execute function app.tg_set_audit_columns();
create trigger trg_manual_visits_audit after insert or update or delete on public.manual_visits
  for each row execute function app.tg_write_audit();

-- Guard the safe-delete rule server-side even against a direct UPDATE that
-- bypasses app.delete_manual_visit (mirrors app.archive_booking_scope's
-- linked_financial_record guard, 20260922130000_safe_booking_archive.sql:19-20).
create or replace function app.tg_manual_visits_guard_delete()
returns trigger language plpgsql as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    if old.invoice_id is not null then
      raise exception 'Manual visit % has a linked invoice; it cannot be deleted.', old.id
        using errcode = 'restrict_violation';
    end if;
    if exists (
      select 1 from public.visit_manual_billing
      where organization_id = old.organization_id and source_type = 'manual_visit' and source_id = old.id and undone_at is null
    ) then
      raise exception 'Manual visit % has active manual billing; undo it before deleting.', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
create trigger trg_manual_visits_guard_delete before update on public.manual_visits
  for each row execute function app.tg_manual_visits_guard_delete();

-- =====================================================================
-- visit_manual_billing — "mark manually billed" / undo, for EITHER a
-- completed booking or a manual_visits row. Append-only ledger of billing
-- attempts; "undo" inserts an undo stamp on the same row rather than
-- deleting it, so the audit trail survives (Rule: append-only financial
-- history). At most one ACTIVE (undone_at is null) row per source.
-- =====================================================================
create table public.visit_manual_billing (
  id              uuid          not null default app.fn_uuid_v7(),
  organization_id uuid          not null,
  branch_id       uuid          not null,
  source_type     text          not null,
  source_id       uuid          not null,
  amount          numeric(14,2) not null,
  note            text,
  billed_by       uuid,
  billed_at       timestamptz   not null default now(),
  undone_by       uuid,
  undone_at       timestamptz,
  undone_note     text,
  created_at      timestamptz   not null default now(),
  constraint pk_visit_manual_billing primary key (id),
  constraint fk_visit_manual_billing_organizations foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint fk_visit_manual_billing_branches foreign key (organization_id, branch_id) references public.branches (organization_id, id),
  constraint chk_visit_manual_billing_source_type check (source_type in ('booking','manual_visit')),
  constraint chk_visit_manual_billing_amount check (amount > 0),
  constraint chk_visit_manual_billing_undo check (undone_at is null or undone_by is not null)
);
create index idx_visit_manual_billing_source on public.visit_manual_billing (organization_id, source_type, source_id);
-- Exactly one ACTIVE manual-billing row per visit at a time (re-billing after an
-- undo is allowed and creates a new row, preserving the undone one for audit).
create unique index uq_visit_manual_billing_active on public.visit_manual_billing (organization_id, source_type, source_id)
  where undone_at is null;

-- Append-only except for the one-time undo stamp: block hard delete outright,
-- and block any update that touches the original billing fields (amount/note/
-- billed_by/billed_at/source) or attempts to re-open an already-undone row.
create or replace function app.tg_visit_manual_billing_freeze()
returns trigger language plpgsql as $$
begin
  if old.undone_at is not null then
    raise exception 'Manual billing % was already undone; it cannot be changed again.', old.id
      using errcode = 'restrict_violation';
  end if;
  if (new.organization_id, new.source_type, new.source_id, new.amount, new.note, new.billed_by, new.billed_at) is distinct from
     (old.organization_id, old.source_type, old.source_id, old.amount, old.note, old.billed_by, old.billed_at) then
    raise exception 'Manual billing % original fields are immutable; use undo, not edit.', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end; $$;
create trigger trg_visit_manual_billing_freeze before update on public.visit_manual_billing
  for each row execute function app.tg_visit_manual_billing_freeze();
create trigger trg_visit_manual_billing_block_delete before delete on public.visit_manual_billing
  for each row execute function app.tg_block_hard_delete();

-- =====================================================================
-- RLS capability registration (same generic loop convention as 20260721001100).
-- =====================================================================
alter table public.manual_visits enable row level security;
alter table public.visit_manual_billing enable row level security;

-- Base permissive org+branch isolation grant (same shape as the bookings/orders/
-- invoices/payments branch-scoped loop in 20260721001000_security_rls_isolation.sql:120-131).
-- Without this, the restrictive capability policies below would deny everything —
-- restrictive policies only narrow an existing permissive grant, they never create one.
do $$
declare t text;
begin
  foreach t in array array['manual_visits','visit_manual_billing']
  loop
    execute format($f$
      create policy %1$s_branch_isolation on public.%1$s for all
      using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership() and app.has_branch(branch_id)))
      with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership() and app.has_branch(branch_id)));
    $f$, t);
  end loop;
end $$;

-- Restrictive capability layer (same generic shape as 20260721001100_security_rls_capabilities.sql:307-398).
do $$
declare r record; wcheck text;
begin
  for r in
    select * from (values
      ('manual_visits',        'scheduling', 'booking.read',  'booking.update', false),
      ('visit_manual_billing', 'finance',    'finance.read',  'payment.manage', false)
    ) as m(tbl, module, rperm, wperm, admin_write)
  loop
    execute format($f$
      create policy %1$s_module_gate on public.%1$s as restrictive for all
      using (app.is_platform_admin() or app.has_module(%2$L))
      with check (app.is_platform_admin() or app.has_module(%2$L));
    $f$, r.tbl, r.module);

    execute format($f$
      create policy %1$s_read_cap on public.%1$s as restrictive for select
      using (app.is_platform_admin() or app.has_permission(%2$L));
    $f$, r.tbl, r.rperm);

    wcheck := format('(app.is_platform_admin() or app.has_permission(%L))', r.wperm);
    execute format('create policy %1$s_write_ins on public.%1$s as restrictive for insert with check (%2$s);', r.tbl, wcheck);
    execute format('create policy %1$s_write_upd on public.%1$s as restrictive for update using (%2$s) with check (%2$s);', r.tbl, wcheck);
    execute format('create policy %1$s_write_del on public.%1$s as restrictive for delete using (%2$s);', r.tbl, wcheck);
  end loop;
end $$;

-- Organization-wide "automatic visit logging" toggle. Reuses organizations.settings
-- jsonb (no new table) — see 20260721000200_identity_access.sql:100.
create or replace function app.set_visit_auto_log_enabled(p_enabled boolean)
returns public.organizations language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.organizations;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  update public.organizations
    set settings = jsonb_set(settings, '{visits,auto_log_enabled}', to_jsonb(p_enabled), true)
    where id = v_org
    returning * into v_row;
  return v_row;
end $$;

-- =====================================================================
-- app.create_manual_visit — off-books visit, validated against tenant/
-- customer/pet/branch/fulfillment-mode relationships (Rule from the brief:
-- FKs alone do not prove a correct association).
-- =====================================================================
create or replace function app.create_manual_visit(
  p_branch uuid, p_customer uuid, p_pet uuid, p_fulfillment_mode text,
  p_visit_at timestamptz, p_description text, p_note text)
returns public.manual_visits language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.manual_visits;
begin
  if v_org is null or not app.has_membership() or not app.has_module('scheduling') or not app.has_permission('booking.create') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_visit_at is null or p_description is null or length(trim(p_description)) = 0 then
    raise exception 'invalid_visit_details' using errcode = '22023';
  end if;
  if p_fulfillment_mode not in ('in_store','home','pickup_delivery') then
    raise exception 'invalid_fulfillment_mode' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customers where organization_id = v_org and id = p_customer and deleted_at is null) then
    raise exception 'customer_not_found' using errcode = 'P0002';
  end if;
  if p_pet is not null and not exists (
    select 1 from public.pets where organization_id = v_org and id = p_pet and customer_id = p_customer and deleted_at is null
  ) then
    raise exception 'pet_not_found_for_customer' using errcode = 'P0002';
  end if;
  insert into public.manual_visits (organization_id, branch_id, customer_id, pet_id, fulfillment_mode, visit_at, description, note)
  values (v_org, p_branch, p_customer, p_pet, p_fulfillment_mode, p_visit_at, trim(p_description), nullif(trim(p_note), ''))
  returning * into v_row;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'customer', p_customer, auth.uid(), 'visit.manual_created', 'Manual visit recorded', jsonb_build_object('visit_id', v_row.id));
  return v_row;
end $$;

-- =====================================================================
-- app.delete_manual_visit — safe delete: refuses if the visit already has
-- a linked invoice or an active manual-billing row (mirrors
-- app.archive_booking_scope's "linked_financial_record" guard).
-- =====================================================================
create or replace function app.delete_manual_visit(p_visit uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.manual_visits;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('booking.delete') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.manual_visits where organization_id = v_org and id = p_visit and deleted_at is null for update;
  if not found then raise exception 'visit_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_row.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_row.invoice_id is not null then raise exception 'visit_has_invoice' using errcode = '55000'; end if;
  if exists (select 1 from public.visit_manual_billing where organization_id = v_org and source_type = 'manual_visit' and source_id = p_visit and undone_at is null) then
    raise exception 'visit_has_active_manual_billing' using errcode = '55000';
  end if;
  update public.manual_visits set deleted_at = now(), updated_by = auth.uid() where id = p_visit;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'customer', v_row.customer_id, auth.uid(), 'visit.manual_deleted', 'Manual visit removed', jsonb_build_object('visit_id', p_visit));
end $$;

-- =====================================================================
-- app.mark_visit_manually_billed / app.undo_manual_billing — works for
-- EITHER a completed booking or a manual_visits row (source_type/source_id).
-- Never usable on unfinished, cancelled or no-show bookings, and never
-- usable on a source that already carries a real invoice (avoids the
-- double-count the brief calls out explicitly).
-- =====================================================================
create or replace function app.mark_visit_manually_billed(
  p_source_type text, p_source_id uuid, p_amount numeric, p_note text)
returns public.visit_manual_billing language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_branch uuid;
  v_booking public.bookings;
  v_visit public.manual_visits;
  v_row public.visit_manual_billing;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('invoice.issue') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_source_type not in ('booking','manual_visit') then raise exception 'invalid_source_type' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;

  if p_source_type = 'booking' then
    select * into v_booking from public.bookings where organization_id = v_org and id = p_source_id and deleted_at is null for update;
    if not found then raise exception 'booking_not_found' using errcode = 'P0002'; end if;
    if v_booking.status <> 'completed' then raise exception 'booking_not_completed' using errcode = '55000'; end if;
    v_branch := v_booking.branch_id;
    if exists (
      select 1 from public.orders where organization_id = v_org and booking_id = p_source_id
        and status <> 'canceled' and deleted_at is null
    ) then
      raise exception 'visit_already_invoiced' using errcode = '55000';
    end if;
  else
    select * into v_visit from public.manual_visits where organization_id = v_org and id = p_source_id and deleted_at is null for update;
    if not found then raise exception 'visit_not_found' using errcode = 'P0002'; end if;
    if v_visit.invoice_id is not null then raise exception 'visit_already_invoiced' using errcode = '55000'; end if;
    v_branch := v_visit.branch_id;
  end if;

  if not app.has_branch(v_branch) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if exists (
    select 1 from public.visit_manual_billing where organization_id = v_org and source_type = p_source_type and source_id = p_source_id and undone_at is null
  ) then
    raise exception 'already_manually_billed' using errcode = '55000';
  end if;

  insert into public.visit_manual_billing (organization_id, branch_id, source_type, source_id, amount, note, billed_by)
  values (v_org, v_branch, p_source_type, p_source_id, p_amount, nullif(trim(p_note), ''), auth.uid())
  returning * into v_row;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, case when p_source_type = 'booking' then 'booking' else 'manual_visit' end, p_source_id,
          auth.uid(), 'visit.manually_billed', 'Visit marked manually billed', jsonb_build_object('billing_id', v_row.id, 'amount', p_amount));
  return v_row;
end $$;

create or replace function app.undo_manual_billing(p_billing uuid, p_note text)
returns public.visit_manual_billing language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.visit_manual_billing;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('invoice.issue') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.visit_manual_billing where organization_id = v_org and id = p_billing for update;
  if not found then raise exception 'manual_billing_not_found' using errcode = 'P0002'; end if;
  if v_row.undone_at is not null then raise exception 'already_undone' using errcode = '55000'; end if;
  update public.visit_manual_billing
    set undone_at = now(), undone_by = auth.uid(), undone_note = nullif(trim(p_note), '')
    where id = p_billing
    returning * into v_row;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, case when v_row.source_type = 'booking' then 'booking' else 'manual_visit' end, v_row.source_id,
          auth.uid(), 'visit.manual_billing_undone', 'Manual billing undone', jsonb_build_object('billing_id', p_billing));
  return v_row;
end $$;

-- =====================================================================
-- app.link_manual_visit_invoice — attach an already-issued invoice to a
-- manual visit (customer must match; blocks if manual billing is still
-- active, forcing an explicit undo first so revenue is never double-counted).
-- =====================================================================
create or replace function app.link_manual_visit_invoice(p_visit uuid, p_invoice uuid)
returns public.manual_visits language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_visit public.manual_visits; v_invoice public.invoices;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('invoice.issue') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_visit from public.manual_visits where organization_id = v_org and id = p_visit and deleted_at is null for update;
  if not found then raise exception 'visit_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_visit.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_invoice from public.invoices where organization_id = v_org and id = p_invoice;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  if v_invoice.status = 'void' then raise exception 'invoice_void' using errcode = '55000'; end if;
  if v_invoice.customer_id is distinct from v_visit.customer_id then raise exception 'invoice_customer_mismatch' using errcode = '55000'; end if;
  if exists (select 1 from public.visit_manual_billing where organization_id = v_org and source_type = 'manual_visit' and source_id = p_visit and undone_at is null) then
    raise exception 'visit_has_active_manual_billing' using errcode = '55000';
  end if;
  update public.manual_visits set invoice_id = p_invoice, updated_by = auth.uid() where id = p_visit returning * into v_visit;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'customer', v_visit.customer_id, auth.uid(), 'visit.invoice_linked', 'Invoice linked to manual visit', jsonb_build_object('visit_id', p_visit, 'invoice_id', p_invoice));
  return v_visit;
end $$;

-- =====================================================================
-- app.create_invoice_from_manual_visit — mirrors app.create_package_invoice's
-- request_key idempotency (20260924120000_invoice_workflow.sql:76-105).
-- =====================================================================
create or replace function app.create_invoice_from_manual_visit(
  p_visit uuid, p_issued_at timestamptz, p_due_at timestamptz, p_amount numeric, p_admin_notes text, p_request_key uuid)
returns public.invoices language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_visit public.manual_visits;
  v_order public.orders;
  v_invoice public.invoices;
  v_currency text;
  v_number text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('invoice.issue') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_key is null or p_issued_at is null or p_amount is null or p_amount <= 0
     or (p_due_at is not null and p_due_at < p_issued_at) then
    raise exception 'invalid_invoice_details' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices where organization_id = v_org and request_key = p_request_key;
  if found then return v_invoice; end if;

  select * into v_visit from public.manual_visits where organization_id = v_org and id = p_visit and deleted_at is null for update;
  if not found then raise exception 'visit_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_visit.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_visit.invoice_id is not null then raise exception 'visit_already_invoiced' using errcode = '55000'; end if;
  if exists (select 1 from public.visit_manual_billing where organization_id = v_org and source_type = 'manual_visit' and source_id = v_visit.id and undone_at is null) then
    raise exception 'visit_has_active_manual_billing' using errcode = '55000';
  end if;

  select coalesce(nullif(settings->>'currency',''),'IDR') into v_currency from public.organizations where id = v_org;

  insert into public.orders (organization_id, branch_id, customer_id, status, currency, metadata)
  values (v_org, v_visit.branch_id, v_visit.customer_id, 'confirmed', v_currency,
          jsonb_build_object('billing_mode','after_visit','source','manual_visit','request_key',p_request_key))
  returning * into v_order;
  insert into public.order_items (organization_id, order_id, item_type, name_snapshot, quantity, unit_price, line_total, metadata)
  values (v_org, v_order.id, 'fee', left(v_visit.description, 160), 1, p_amount, p_amount,
          jsonb_build_object('source','manual_visit','visit_id', v_visit.id));
  select * into v_order from public.orders where id = v_order.id;

  v_number := 'VIS-' || to_char(p_issued_at at time zone 'Asia/Jakarta', 'YYYYMMDD') || '-' || upper(substr(replace(p_request_key::text,'-',''),1,8));
  insert into public.invoices (organization_id, branch_id, customer_id, order_id, invoice_number, status, currency,
    subtotal, discount_total, tax_total, total, issued_at, due_at, billing_mode, document_type, admin_notes, request_key, metadata)
  values (v_org, v_visit.branch_id, v_visit.customer_id, v_order.id, v_number, 'issued', v_order.currency,
    v_order.subtotal, v_order.discount_total, v_order.tax_total, v_order.total, p_issued_at, p_due_at,
    'after_visit', 'invoice', left(nullif(trim(p_admin_notes),''),2000), p_request_key,
    jsonb_build_object('source','manual_visit','visit_id', v_visit.id))
  returning * into v_invoice;
  insert into public.invoice_lines (organization_id, invoice_id, item_type, name_snapshot, quantity, unit_price, line_total)
  values (v_org, v_invoice.id, 'fee', left(v_visit.description, 160), 1, p_amount, p_amount);

  update public.manual_visits set invoice_id = v_invoice.id, updated_by = auth.uid() where id = v_visit.id;
  return v_invoice;
end $$;

revoke all on function
  app.set_visit_auto_log_enabled(boolean),
  app.create_manual_visit(uuid,uuid,uuid,text,timestamptz,text,text),
  app.delete_manual_visit(uuid),
  app.mark_visit_manually_billed(text,uuid,numeric,text),
  app.undo_manual_billing(uuid,text),
  app.link_manual_visit_invoice(uuid,uuid),
  app.create_invoice_from_manual_visit(uuid,timestamptz,timestamptz,numeric,text,uuid)
from public;
grant execute on function
  app.set_visit_auto_log_enabled(boolean),
  app.create_manual_visit(uuid,uuid,uuid,text,timestamptz,text,text),
  app.delete_manual_visit(uuid),
  app.mark_visit_manually_billed(text,uuid,numeric,text),
  app.undo_manual_billing(uuid,text),
  app.link_manual_visit_invoice(uuid,uuid),
  app.create_invoice_from_manual_visit(uuid,timestamptz,timestamptz,numeric,text,uuid)
to authenticated;

notify pgrst, 'reload schema';
commit;
