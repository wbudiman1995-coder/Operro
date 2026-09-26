-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20260926090000_membership_renewal_billing_and_reconciliation
-- Purpose          Follow-up to 20260925100000 (sections 23-26), closing the
--                  gaps found in independent review:
--                    1. Manual package renewal now creates a real invoice
--                       (order + invoice + invoice_lines + ledger row), not
--                       just a session top-up. Branch is an explicit,
--                       authorized caller input -- never guessed.
--                    2. customer_package_ledger gains invoice_id so every
--                       purchase/renewal ledger row links to the invoice
--                       that caused it (membership administration history).
--                    3. app.reconcile_customer_package is rewritten to
--                       verify actual ledger<->reservation LINKS (not just
--                       counts), purchase/renewal invoice linkage, over-
--                       reservation, and expiry/status inconsistency, and to
--                       separate "automatically repairable" (cache-vs-ledger)
--                       from "manual review required" (financial/history
--                       gaps -- never auto-repaired).
-- Compatibility    Forward-only, additive. app.renew_customer_package's
--                  signature and return type change (it now returns an
--                  invoice, not a customer_packages row) because its
--                  contract changed: a paid renewal must produce a billing
--                  document. Every existing column is untouched; no prior
--                  migration is edited.
-- Amended          This file was amended in place (not layered under a
--                  third migration) after independent review, because it
--                  had never been applied outside disposable, destroyed-
--                  after-use test containers -- no shared/production
--                  environment has ever run it. Fixes folded in: removed a
--                  backfill UPDATE against the append-only
--                  customer_package_ledger table (it would raise
--                  restrict_violation the moment it ran against a database
--                  that already had real purchase rows -- see the
--                  invoice_id column comment); made rollover_policy actually
--                  govern renewal (it was previously read but never
--                  consumed); stopped comparing catalog price in the
--                  renewal idempotency check (price is server-derived, not
--                  a caller input, so comparing it broke a legitimate retry
--                  after a catalog price change); added a per_pet/pet_id
--                  compatibility guard plus a new read-only
--                  app.preview_package_renewal; and replaced the
--                  invoice-linkage check's "is invoice_id non-null" test
--                  with an actual link-validity check (right customer,
--                  right package, non-void status, matching invoice line),
--                  plus missing_reversal_link and duplicate_consumption_links.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- SECTION 1 — customer_package_ledger: link purchase/renewal rows to the
-- invoice that caused them (membership administration history, section 25;
-- reconciliation invoice-linkage checks, section 26).
-- ---------------------------------------------------------------------
alter table public.customer_package_ledger
  add column invoice_id uuid;

alter table public.customer_package_ledger
  add constraint fk_cpl_invoice foreign key (organization_id, invoice_id)
    references public.invoices (organization_id, id);

create index idx_cpl_invoice on public.customer_package_ledger (organization_id, invoice_id) where invoice_id is not null;

comment on column public.customer_package_ledger.invoice_id is
  'The invoice that produced this purchase/renewal row (section 24/25/26). Set going forward by create_package_invoice/renew_customer_package at INSERT time only. Deliberately NEVER backfilled onto pre-existing rows: customer_package_ledger is append-only (trg_cpl_block_update unconditionally rejects any UPDATE), so a migration that tried to backfill this column would raise restrict_violation the moment it ran against a database that already had real purchase rows -- passing silently only on a fresh, empty schema. Historical purchase provenance is already available via customer_packages.source_invoice_id (set at purchase time since the prior migration); reconcile_customer_package reads that column directly for legacy rows instead of requiring a retrofitted ledger column.';

-- ---------------------------------------------------------------------
-- SECTION 2 — create_package_invoice: same behavior, now also stamps the
-- purchase ledger row's invoice_id. Signature unchanged (create or replace).
-- ---------------------------------------------------------------------
create or replace function app.create_package_invoice(
  p_branch uuid, p_customer uuid, p_package uuid, p_issued_at timestamptz, p_due_at timestamptz,
  p_admin_notes text, p_request_key uuid, p_pet uuid default null)
returns public.invoices language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_pkg public.packages; v_order public.orders; v_invoice public.invoices; v_cp uuid; v_number text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_module('membership')
     or not app.has_permission('invoice.issue') or not app.has_permission('membership.manage') or not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_request_key is null or p_issued_at is null or (p_due_at is not null and p_due_at<p_issued_at) then raise exception 'invalid_invoice_details' using errcode='22023'; end if;
  select * into v_invoice from public.invoices where organization_id=v_org and request_key=p_request_key;
  if found then
    if v_invoice.branch_id <> p_branch or v_invoice.customer_id <> p_customer
       or v_invoice.metadata->>'package_id' is distinct from p_package::text
       or not exists (select 1 from public.customer_packages existing_package
           where existing_package.organization_id=v_org and existing_package.source_invoice_id=v_invoice.id
             and existing_package.pet_id is not distinct from p_pet) then
      raise exception 'request_key_reused_for_different_invoice' using errcode='22023';
    end if;
    return v_invoice;
  end if;
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
  insert into public.customer_package_ledger(organization_id,customer_package_id,delta,reason,notes,invoice_id)
  values(v_org,v_cp,v_pkg.total_sessions,'purchase','Invoice '||v_number,v_invoice.id);
  return v_invoice;
end $$;

-- ---------------------------------------------------------------------
-- SECTION 3 — renew_customer_package: replaced. A manual renewal is now a
-- real commercial transaction (order + invoice + invoice_lines), exactly
-- like the original sale in create_package_invoice, not a silent session
-- top-up. This is a breaking signature/return-type change (drop + create):
-- the old 2-arg "grant sessions only" contract is gone because it produced
-- no billing document, which is the bug this migration fixes.
--
-- Policy (documented once, applied uniformly to every status -- active,
-- exhausted, expired, canceled-rejected, zero-price, and legacy packages
-- with no source_invoice_id):
--   - Held (reserved) sessions are ALWAYS protected: a renewal never reduces
--     sessions_remaining below the count currently reserved, regardless of
--     rollover_policy.
--   - Beyond that floor, rollover_policy governs the UNRESERVED balance:
--     'rollover' adds pkg.total_sessions on top of whatever is left
--     (sessions_remaining is a ledger SUM; nothing is discarded).
--     'none' discards only the unreserved excess (via one compensating
--     'adjustment' ledger row, never a raw UPDATE) before adding
--     pkg.total_sessions, so the resulting available balance is exactly
--     pkg.total_sessions and reserved sessions are untouched.
--   - Expiry ALWAYS extends from greatest(now(), current expires_at): an
--     active package loses no paid-for remaining time; an already-expired
--     one restarts its term from today. Same formula regardless of status.
--   - The invoice is ALWAYS created, even for a zero-price package -- an
--     "issued" invoice is a billing record, not proof of payment (payments
--     are a separate table/flow, matching the pre-existing invoice
--     lifecycle); this RPC never marks anything paid.
--   - Branch is a REQUIRED, caller-supplied argument. It is never inferred
--     from the (possibly absent, for legacy rows) source invoice; the
--     caller (UI) may default the field to the source invoice's branch when
--     known, but the staff member must explicitly confirm/choose it.
--   - Canceled packages cannot be renewed (unchanged from before).
--   - An inactive catalog package cannot be renewed (unchanged from
--     before): its terms are no longer sold, so it cannot be topped up
--     either.
--   - If the catalog's per_pet flag has changed since this membership was
--     sold such that it now disagrees with whether this membership actually
--     has a pet scope (cp.pet_id), the renewal is REFUSED
--     (catalog_terms_changed_incompatible_with_existing_entitlement) rather
--     than silently topping up an old entitlement under new, incompatible
--     terms. app.preview_package_renewal (below) surfaces this before the
--     staff member ever attempts the write.
--
-- Idempotency / concurrency (same shape as create_package_invoice /
-- repair_customer_package_balance, reviewed on this branch): the
-- customer_packages row is locked with SELECT ... FOR UPDATE FIRST, so a
-- retry/double-click/timeout-retry for the SAME package serializes on that
-- lock; by the time the second call reads public.invoices for the
-- request_key, the first call's invoice (if any) is already committed and
-- visible, so it is returned unchanged rather than re-created. The
-- idempotent-return check compares ONLY genuinely caller-supplied material
-- inputs (the membership being renewed, and the branch) -- NOT the
-- catalog's current price, which is server-derived state that can
-- legitimately drift between the original call and a retry without making
-- the retry illegitimate. A request key reused for a DIFFERENT membership
-- or a different branch is rejected; a plain retry after a catalog price
-- change returns the original invoice unchanged, exactly as it should.
-- Order matches the reviewed pattern on this branch: lock -> authorize ->
-- idempotent-return check -> business validation -> mutate.
-- ---------------------------------------------------------------------
drop function if exists app.renew_customer_package(uuid, uuid);

create function app.renew_customer_package(
  p_customer_package uuid, p_branch uuid, p_issued_at timestamptz, p_due_at timestamptz,
  p_admin_notes text, p_request_key uuid)
returns public.invoices
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid; cp public.customer_packages; pkg public.packages; v_invoice public.invoices; v_order public.orders;
  v_new_expiry timestamptz; v_interval interval; v_number text; v_line_name text;
  v_reserved_count integer; v_unreserved_excess integer;
begin
  v_org := app.fn_active_organization();
  if p_request_key is null or p_issued_at is null or (p_due_at is not null and p_due_at < p_issued_at) then
    raise exception 'invalid_invoice_details' using errcode = '22023';
  end if;

  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_module('membership')
     or not app.has_permission('invoice.issue') or not app.has_permission('membership.manage') or not app.has_branch(p_branch) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into pkg from public.packages where organization_id = v_org and id = cp.package_id;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  -- Idempotent return: same request_key must mean the same renewal (same
  -- membership, same branch) -- catalog price is deliberately NOT compared
  -- here (see the comment block above this function).
  select * into v_invoice from public.invoices where organization_id = v_org and request_key = p_request_key;
  if found then
    if v_invoice.branch_id <> p_branch
       or v_invoice.metadata->>'renewal_of' is distinct from cp.id::text then
      raise exception 'request_key_reused_for_different_renewal' using errcode = '22023';
    end if;
    return v_invoice;
  end if;

  if cp.status = 'canceled' then raise exception 'package_canceled_cannot_renew' using errcode = 'check_violation'; end if;
  if not pkg.is_active then raise exception 'package_catalog_inactive' using errcode = 'check_violation'; end if;
  if pkg.per_pet <> (cp.pet_id is not null) then
    raise exception 'catalog_terms_changed_incompatible_with_existing_entitlement' using errcode = 'check_violation';
  end if;

  v_interval := case pkg.recurrence_interval
    when 'week' then interval '7 days'
    when 'month' then interval '1 month'
    when 'year' then interval '1 year'
    else (coalesce(pkg.validity_days, 30) || ' days')::interval
  end;
  v_new_expiry := greatest(now(), coalesce(cp.expires_at, now())) + v_interval;
  v_line_name := pkg.name || ' (Perpanjangan #' || (cp.renewal_count + 1) || ')';

  insert into public.orders(organization_id, branch_id, customer_id, status, currency, metadata)
  values (v_org, p_branch, cp.customer_id, 'confirmed', pkg.currency,
          jsonb_build_object('billing_mode', 'package_sale', 'request_key', p_request_key, 'renewal_of', cp.id))
  returning * into v_order;
  insert into public.order_items(organization_id, order_id, item_type, package_id, name_snapshot, quantity, unit_price, line_total, pricing_breakdown, metadata)
  values (v_org, v_order.id, 'package', pkg.id, v_line_name, 1, pkg.price, pkg.price,
          jsonb_build_object('sessions', pkg.total_sessions, 'recurrence_interval', pkg.recurrence_interval),
          jsonb_build_object('source', 'package_renewal', 'renewal_of', cp.id));

  v_number := 'PKR-' || to_char(p_issued_at at time zone 'Asia/Jakarta', 'YYYYMMDD') || '-' || upper(substr(replace(p_request_key::text, '-', ''), 1, 8));
  insert into public.invoices(organization_id, branch_id, customer_id, order_id, invoice_number, status, currency,
    subtotal, discount_total, tax_total, total, issued_at, due_at, billing_mode, document_type, admin_notes, request_key, metadata)
  values (v_org, p_branch, cp.customer_id, v_order.id, v_number, 'issued', pkg.currency,
    pkg.price, 0, 0, pkg.price, p_issued_at, p_due_at, 'package_sale', 'invoice',
    left(nullif(trim(p_admin_notes), ''), 2000), p_request_key,
    jsonb_build_object('package_id', pkg.id, 'renewal_of', cp.id))
  returning * into v_invoice;
  insert into public.invoice_lines(organization_id, invoice_id, item_type, package_id, name_snapshot, quantity, unit_price, line_total, pricing_breakdown)
  values (v_org, v_invoice.id, 'package', pkg.id, v_line_name, 1, pkg.price, pkg.price,
          jsonb_build_object('sessions', pkg.total_sessions, 'recurrence_interval', pkg.recurrence_interval));

  -- rollover_policy = 'none': the unreserved excess above the currently-held
  -- (reserved) sessions does not carry into the new term. Reserved sessions
  -- are NEVER touched -- they back a real, already-scheduled booking line.
  -- Implemented as an explicit compensating ledger row (never a raw UPDATE
  -- to sessions_remaining), so the ledger remains the single source of
  -- truth and reconcile_customer_package never sees a cache/ledger gap.
  if pkg.rollover_policy = 'none' then
    select count(*) into v_reserved_count from public.package_reservations
     where organization_id = v_org and customer_package_id = cp.id and status = 'reserved';
    v_unreserved_excess := greatest(0, cp.sessions_remaining - v_reserved_count);
    if v_unreserved_excess > 0 then
      insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes)
      values (v_org, cp.id, -v_unreserved_excess, 'adjustment', 'rollover_policy=none: unused (unreserved) sessions do not carry into the new term');
    end if;
  end if;

  update public.customer_packages
     set status = 'active', expires_at = v_new_expiry, renewed_at = now(), renewal_count = renewal_count + 1
   where id = cp.id;

  insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes, request_key, invoice_id)
  values (v_org, cp.id, pkg.total_sessions, 'renewal', 'Renewal invoice ' || v_number, p_request_key, v_invoice.id);

  return v_invoice;
end; $$;

revoke all on function app.renew_customer_package(uuid, uuid, timestamptz, timestamptz, text, uuid) from public, authenticated;
grant execute on function app.renew_customer_package(uuid, uuid, timestamptz, timestamptz, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 3B — preview_package_renewal: READ-ONLY. Shows exactly what a
-- renewal would do (price, sessions to add, currency, pet/service scope,
-- resulting expiry, and whether the catalog's terms have drifted
-- incompatibly since this membership was sold) BEFORE the staff member
-- commits to the write. Never writes; membership.read is sufficient.
-- ---------------------------------------------------------------------
create or replace function app.preview_package_renewal(p_customer_package uuid)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid; cp public.customer_packages; pkg public.packages;
  v_interval interval; v_new_expiry timestamptz; v_reserved_count integer; v_unreserved_excess integer;
  v_incompatible boolean;
begin
  v_org := app.fn_active_organization();
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.read');

  select * into pkg from public.packages where organization_id = v_org and id = cp.package_id;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  v_incompatible := cp.status <> 'canceled' and pkg.per_pet <> (cp.pet_id is not null);

  v_interval := case pkg.recurrence_interval
    when 'week' then interval '7 days'
    when 'month' then interval '1 month'
    when 'year' then interval '1 year'
    else (coalesce(pkg.validity_days, 30) || ' days')::interval
  end;
  v_new_expiry := greatest(now(), coalesce(cp.expires_at, now())) + v_interval;

  select count(*) into v_reserved_count from public.package_reservations
   where organization_id = v_org and customer_package_id = cp.id and status = 'reserved';
  v_unreserved_excess := case when pkg.rollover_policy = 'none' then greatest(0, cp.sessions_remaining - v_reserved_count) else 0 end;

  return jsonb_build_object(
    'customer_package_id', cp.id, 'package_id', pkg.id, 'package_name', pkg.name,
    'price', pkg.price, 'currency', pkg.currency, 'sessions_to_add', pkg.total_sessions,
    'rollover_policy', pkg.rollover_policy, 'recurrence_interval', pkg.recurrence_interval,
    'pet_id', cp.pet_id, 'service_id', cp.service_id,
    'current_available', greatest(0, cp.sessions_remaining - v_reserved_count),
    'sessions_discarded_if_renewed', v_unreserved_excess,
    'resulting_available', greatest(0, cp.sessions_remaining - v_reserved_count) - v_unreserved_excess + pkg.total_sessions,
    'current_expires_at', cp.expires_at, 'resulting_expires_at', v_new_expiry,
    'catalog_active', pkg.is_active, 'membership_status', cp.status,
    'incompatible', v_incompatible,
    'blocking_reason', case
      when cp.status = 'canceled' then 'package_canceled_cannot_renew'
      when not pkg.is_active then 'package_catalog_inactive'
      when v_incompatible then 'catalog_terms_changed_incompatible_with_existing_entitlement'
      else null
    end);
end; $$;

revoke all on function app.preview_package_renewal(uuid) from public, authenticated;
grant execute on function app.preview_package_renewal(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 4 — reconcile_customer_package: deep lifecycle reconciliation
-- (section 26). Still STABLE / no writes. Extends the prior cache-vs-ledger
-- check with real LINK verification (not count comparison, and not merely
-- "is invoice_id non-null" -- the linked invoice itself is validated):
--   - Every 'consumed' reservation's consumption_ledger_id must point to an
--     actual reason='consumption' ledger row for the SAME package.
--   - Every reservation with a reversal_ledger_id must point to an actual
--     reason='adjustment' ledger row for the SAME package.
--   - A reservation that WAS consumed (consumption_ledger_id is not null)
--     but is no longer status='consumed' MUST have a reversal_ledger_id --
--     a "released after consumption" row with no reversal link is broken
--     (missing_reversal_link).
--   - No two reservations may share the same consumption_ledger_id
--     (duplicate_consumption_links) -- there is no DB uniqueness constraint
--     on that column, so this is a genuine, checkable invariant, not a
--     structurally-impossible case.
--   - Every reason='renewal' ledger row should carry an invoice_id
--     (reason='purchase' rows are NOT required to -- see the invoice_id
--     column comment above; that provenance lives on
--     customer_packages.source_invoice_id instead, checked separately).
--   - A non-null invoice_id must point to a REAL, matching invoice: same
--     organization AND customer, a relevant status (issued/paid, not
--     void), and at least one invoice_lines row for the same package_id.
--     A non-null FK alone (satisfied by any invoice in the same org) is
--     NOT sufficient proof of correct provenance.
--   - The package's own source_invoice_id presence (legacy flag).
--   - Over-reservation: reserved_count must never exceed the cached
--     balance (would mean more capacity is held than exists).
--   - Expiry/status inconsistency: status='active' with expires_at in the
--     past (informational -- the codebase does not auto-transition status
--     on expiry; RPCs check expires_at directly -- but worth surfacing).
--
-- The report separates `auto_repairable` (cache-vs-ledger drift only --
-- the ONLY thing repair_customer_package_balance may fix) from
-- `manual_review_issues` (an array of issue codes for financial/history
-- gaps that must never be auto-repaired, per the instruction not to invent
-- missing invoices/ledger history).
-- ---------------------------------------------------------------------
create or replace function app.reconcile_customer_package(p_customer_package uuid)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid; cp public.customer_packages;
  v_ledger_balance numeric; v_reserved integer;
  v_consumed_reservations integer; v_consumed_ledger integer;
  v_invalid_consumption_links integer; v_invalid_reversal_links integer;
  v_orphan_consumption_ledger integer; v_unlinked_renewal integer;
  v_invalid_invoice_links integer; v_missing_reversal_link integer; v_duplicate_consumption_links integer;
  v_over_reserved boolean; v_expired_status_mismatch boolean; v_missing_source_invoice boolean;
  v_manual_review jsonb := '[]'::jsonb;
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

  -- Real link checks, not count comparisons: a 'consumed' reservation whose
  -- consumption_ledger_id is null, or points at a row that isn't actually a
  -- matching consumption ledger entry, is broken even if the totals happen
  -- to match.
  select count(*) into v_invalid_consumption_links
    from public.package_reservations pr
   where pr.organization_id = v_org and pr.customer_package_id = p_customer_package and pr.status = 'consumed'
     and not exists (
       select 1 from public.customer_package_ledger cpl
        where cpl.organization_id = v_org and cpl.id = pr.consumption_ledger_id
          and cpl.customer_package_id = p_customer_package and cpl.reason = 'consumption' and cpl.delta = -1
     );

  select count(*) into v_invalid_reversal_links
    from public.package_reservations pr
   where pr.organization_id = v_org and pr.customer_package_id = p_customer_package and pr.reversal_ledger_id is not null
     and not exists (
       select 1 from public.customer_package_ledger cpl
        where cpl.organization_id = v_org and cpl.id = pr.reversal_ledger_id
          and cpl.customer_package_id = p_customer_package and cpl.reason = 'adjustment' and cpl.delta = 1
     );

  -- A reservation that was consumed at some point (it has a
  -- consumption_ledger_id) but is not CURRENTLY 'consumed' must have gone
  -- through reverse_package_reservation, which always sets
  -- reversal_ledger_id -- a released-after-consumption row with no reversal
  -- link is a broken invariant, not a legitimate state.
  select count(*) into v_missing_reversal_link
    from public.package_reservations pr
   where pr.organization_id = v_org and pr.customer_package_id = p_customer_package
     and pr.consumption_ledger_id is not null and pr.status <> 'consumed' and pr.reversal_ledger_id is null;

  -- No two reservations may point at the same consumption ledger row (no DB
  -- uniqueness constraint enforces this on package_reservations directly).
  select count(*) into v_duplicate_consumption_links
    from public.package_reservations pr1
   where pr1.organization_id = v_org and pr1.customer_package_id = p_customer_package
     and pr1.consumption_ledger_id is not null
     and exists (
       select 1 from public.package_reservations pr2
        where pr2.organization_id = v_org and pr2.id <> pr1.id
          and pr2.consumption_ledger_id = pr1.consumption_ledger_id
     );

  -- An orphan consumption ledger row: one no reservation actually links back
  -- to (would mean a session was deducted without a corresponding held
  -- reservation ever being marked consumed).
  select count(*) into v_orphan_consumption_ledger
    from public.customer_package_ledger cpl
   where cpl.organization_id = v_org and cpl.customer_package_id = p_customer_package and cpl.reason = 'consumption'
     and not exists (
       select 1 from public.package_reservations pr
        where pr.organization_id = v_org and pr.consumption_ledger_id = cpl.id
     );

  -- Purchase provenance lives on customer_packages.source_invoice_id (see
  -- missing_source_invoice below); only 'renewal' rows are required to
  -- self-link via invoice_id (every renewal since this migration sets it).
  select count(*) into v_unlinked_renewal
    from public.customer_package_ledger cpl
   where cpl.organization_id = v_org and cpl.customer_package_id = p_customer_package
     and cpl.reason = 'renewal' and cpl.invoice_id is null;

  -- A non-null invoice_id is not proof of correct provenance by itself --
  -- the FK only guarantees the invoice exists in the same organization.
  -- Verify it actually belongs to THIS customer and THIS package, is not
  -- void, and has a matching invoice line.
  select count(*) into v_invalid_invoice_links
    from public.customer_package_ledger cpl
   where cpl.organization_id = v_org and cpl.customer_package_id = p_customer_package
     and cpl.reason in ('purchase', 'renewal') and cpl.invoice_id is not null
     and not exists (
       select 1 from public.invoices i
        where i.organization_id = v_org and i.id = cpl.invoice_id
          and i.customer_id = cp.customer_id and i.status in ('issued', 'paid')
          and exists (
            select 1 from public.invoice_lines il
             where il.organization_id = v_org and il.invoice_id = i.id
               and il.item_type = 'package' and il.package_id = cp.package_id
          )
     );

  v_missing_source_invoice := cp.source_invoice_id is null;
  v_over_reserved := v_reserved > cp.sessions_remaining;
  v_expired_status_mismatch := cp.status = 'active' and cp.expires_at is not null and cp.expires_at < now();

  if v_invalid_consumption_links > 0 then v_manual_review := v_manual_review || jsonb_build_array('invalid_consumption_links'); end if;
  if v_invalid_reversal_links > 0 then v_manual_review := v_manual_review || jsonb_build_array('invalid_reversal_links'); end if;
  if v_missing_reversal_link > 0 then v_manual_review := v_manual_review || jsonb_build_array('missing_reversal_link'); end if;
  if v_duplicate_consumption_links > 0 then v_manual_review := v_manual_review || jsonb_build_array('duplicate_consumption_links'); end if;
  if v_orphan_consumption_ledger > 0 then v_manual_review := v_manual_review || jsonb_build_array('orphan_consumption_ledger_entries'); end if;
  if v_unlinked_renewal > 0 then v_manual_review := v_manual_review || jsonb_build_array('unlinked_renewal_invoice'); end if;
  if v_invalid_invoice_links > 0 then v_manual_review := v_manual_review || jsonb_build_array('invalid_invoice_links'); end if;
  if v_missing_source_invoice then v_manual_review := v_manual_review || jsonb_build_array('missing_source_invoice'); end if;
  if v_over_reserved then v_manual_review := v_manual_review || jsonb_build_array('over_reserved'); end if;
  if v_expired_status_mismatch then v_manual_review := v_manual_review || jsonb_build_array('expired_but_status_active'); end if;

  return jsonb_build_object(
    'customer_package_id', cp.id, 'revision', cp.revision, 'status', cp.status,
    'cached_balance', cp.sessions_remaining, 'ledger_balance', v_ledger_balance,
    'balance_matches', cp.sessions_remaining = v_ledger_balance,
    'auto_repairable', cp.sessions_remaining <> v_ledger_balance,
    'reserved_count', v_reserved, 'consumed_reservations', v_consumed_reservations,
    'consumption_ledger_entries', v_consumed_ledger,
    'reservation_consumption_matches', v_consumed_reservations = v_consumed_ledger
      and v_invalid_consumption_links = 0 and v_orphan_consumption_ledger = 0
      and v_missing_reversal_link = 0 and v_duplicate_consumption_links = 0,
    'invalid_consumption_links', v_invalid_consumption_links,
    'invalid_reversal_links', v_invalid_reversal_links,
    'missing_reversal_link', v_missing_reversal_link,
    'duplicate_consumption_links', v_duplicate_consumption_links,
    'orphan_consumption_ledger_entries', v_orphan_consumption_ledger,
    'unlinked_renewal_invoice_entries', v_unlinked_renewal,
    'invalid_invoice_links', v_invalid_invoice_links,
    'missing_source_invoice', v_missing_source_invoice,
    'over_reserved', v_over_reserved,
    'expired_but_status_active', v_expired_status_mismatch,
    'manual_review_issues', v_manual_review,
    'checked_at', now());
end; $$;

revoke all on function app.reconcile_customer_package(uuid) from public, authenticated;
grant execute on function app.reconcile_customer_package(uuid) to authenticated;

commit;
