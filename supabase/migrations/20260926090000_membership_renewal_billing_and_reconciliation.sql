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
  'The invoice that produced this purchase/renewal row (section 24/25/26). Null for consumption/adjustment/expiry/refund rows and for legacy purchase rows sold before this column existed (see customer_packages.source_invoice_id for those).';

-- Backfill: every existing 'purchase' ledger row can be linked back to its
-- customer_package's source_invoice_id (already populated by the prior
-- migration's backfill). Renewal rows created before this migration (there
-- can be none yet on a fresh install, but a shared environment may already
-- have run 20260925100000) have no invoice to link to -- they predate paid
-- renewal and are left null, which reconcile_customer_package below reports
-- as a legacy gap rather than an error.
update public.customer_package_ledger cpl
   set invoice_id = cp.source_invoice_id
  from public.customer_packages cp
 where cp.organization_id = cpl.organization_id
   and cp.id = cpl.customer_package_id
   and cpl.reason = 'purchase'
   and cpl.invoice_id is null
   and cp.source_invoice_id is not null;

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
--   - Sessions ALWAYS roll over: the renewal is a +pkg.total_sessions ledger
--     row on top of whatever is left (sessions_remaining is a ledger SUM;
--     there is no separate "reset to catalog total" path).
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
--
-- Idempotency / concurrency (same shape as create_package_invoice /
-- repair_customer_package_balance, reviewed on this branch): the
-- customer_packages row is locked with SELECT ... FOR UPDATE FIRST, so a
-- retry/double-click/timeout-retry for the SAME package serializes on that
-- lock; by the time the second call reads public.invoices for the
-- request_key, the first call's invoice (if any) is already committed and
-- visible, so it is returned unchanged rather than re-created. A request
-- key reused for a DIFFERENT membership, at a different branch, or after
-- the catalog price changed, is rejected rather than silently returned.
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
  -- membership, same branch, same catalog price observed at the time) --
  -- anything else is a reused key with different material inputs.
  select * into v_invoice from public.invoices where organization_id = v_org and request_key = p_request_key;
  if found then
    if v_invoice.branch_id <> p_branch
       or v_invoice.metadata->>'renewal_of' is distinct from cp.id::text
       or v_invoice.total <> pkg.price then
      raise exception 'request_key_reused_for_different_renewal' using errcode = '22023';
    end if;
    return v_invoice;
  end if;

  if cp.status = 'canceled' then raise exception 'package_canceled_cannot_renew' using errcode = 'check_violation'; end if;
  if not pkg.is_active then raise exception 'package_catalog_inactive' using errcode = 'check_violation'; end if;

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
-- SECTION 4 — reconcile_customer_package: deep lifecycle reconciliation
-- (section 26). Still STABLE / no writes. Extends the prior cache-vs-ledger
-- check with real LINK verification (not count comparison):
--   - Every 'consumed' reservation's consumption_ledger_id must point to an
--     actual reason='consumption' ledger row for the SAME package.
--   - Every reservation with a reversal_ledger_id must point to an actual
--     reason='adjustment' ledger row for the SAME package.
--   - Every reason in ('purchase','renewal') ledger row should carry an
--     invoice_id (flags legacy rows sold before invoice_id existed as a
--     provenance gap, not an error).
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
  v_orphan_consumption_ledger integer; v_unlinked_purchase_renewal integer;
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

  select count(*) into v_unlinked_purchase_renewal
    from public.customer_package_ledger cpl
   where cpl.organization_id = v_org and cpl.customer_package_id = p_customer_package
     and cpl.reason in ('purchase', 'renewal') and cpl.invoice_id is null;

  v_missing_source_invoice := cp.source_invoice_id is null;
  v_over_reserved := v_reserved > cp.sessions_remaining;
  v_expired_status_mismatch := cp.status = 'active' and cp.expires_at is not null and cp.expires_at < now();

  if v_invalid_consumption_links > 0 then v_manual_review := v_manual_review || jsonb_build_array('invalid_consumption_links'); end if;
  if v_invalid_reversal_links > 0 then v_manual_review := v_manual_review || jsonb_build_array('invalid_reversal_links'); end if;
  if v_orphan_consumption_ledger > 0 then v_manual_review := v_manual_review || jsonb_build_array('orphan_consumption_ledger_entries'); end if;
  if v_unlinked_purchase_renewal > 0 then v_manual_review := v_manual_review || jsonb_build_array('unlinked_purchase_or_renewal_invoice'); end if;
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
      and v_invalid_consumption_links = 0 and v_orphan_consumption_ledger = 0,
    'invalid_consumption_links', v_invalid_consumption_links,
    'invalid_reversal_links', v_invalid_reversal_links,
    'orphan_consumption_ledger_entries', v_orphan_consumption_ledger,
    'unlinked_purchase_or_renewal_invoice_entries', v_unlinked_purchase_renewal,
    'missing_source_invoice', v_missing_source_invoice,
    'over_reserved', v_over_reserved,
    'expired_but_status_active', v_expired_status_mismatch,
    'manual_review_issues', v_manual_review,
    'checked_at', now());
end; $$;

revoke all on function app.reconcile_customer_package(uuid) from public, authenticated;
grant execute on function app.reconcile_customer_package(uuid) to authenticated;

commit;
