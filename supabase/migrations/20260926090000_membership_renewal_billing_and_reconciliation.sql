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
declare v_org uuid:=app.fn_active_organization(); v_pkg public.packages; v_order public.orders; v_invoice public.invoices; v_cp uuid; v_number text; v_normalized_notes text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_module('membership')
     or not app.has_permission('invoice.issue') or not app.has_permission('membership.manage') or not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_request_key is null or p_issued_at is null or (p_due_at is not null and p_due_at<p_issued_at) then raise exception 'invalid_invoice_details' using errcode='22023'; end if;
  v_normalized_notes := left(nullif(trim(p_admin_notes),''),2000);
  select * into v_invoice from public.invoices where organization_id=v_org and request_key=p_request_key;
  if found then
    -- Every genuinely caller-supplied material input is compared, not just
    -- branch/customer/package/pet: issued_at/due_at/admin_notes are also
    -- caller inputs, and a retry that silently changed them would issue an
    -- invoice with different terms than the one the caller thinks they are
    -- retrying (review round 3, finding #1 -- the same gap existed here).
    if v_invoice.branch_id <> p_branch or v_invoice.customer_id <> p_customer
       or v_invoice.metadata->>'package_id' is distinct from p_package::text
       or v_invoice.issued_at <> p_issued_at
       or v_invoice.due_at is distinct from p_due_at
       or v_invoice.admin_notes is distinct from v_normalized_notes
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
  values(v_org,p_branch,p_customer,v_order.id,v_number,'issued',v_order.currency,v_order.subtotal,v_order.discount_total,v_order.tax_total,v_order.total,p_issued_at,p_due_at,'package_sale','invoice',v_normalized_notes,p_request_key,jsonb_build_object('package_id',v_pkg.id)) returning * into v_invoice;
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
--   - Catalog compatibility (review round 3, finding #3 -- replaces the
--     round-2 per_pet check, which was too strict): a sale may optionally
--     bind a pet even when per_pet=false (pet presence alone is not proof
--     the catalog changed), so the only genuinely unsafe per-pet drift is
--     the catalog NOW requiring a pet (per_pet=true) for a membership that
--     was sold with NO pet bound at all (cp.pet_id is null) -- renewal can
--     never retroactively assign one. Symmetrically for service scope:
--     cp.service_id is itself the immutable purchase-time snapshot (set
--     once by create_package_invoice, never touched by renewal), so the
--     only unsafe drift is the catalog's CURRENT service_id being a
--     DIFFERENT specific service than the one this membership was actually
--     sold for (both non-null and different) -- a catalog service_id of
--     NULL ("any service") on either side is never itself a mismatch,
--     since NULL always means "broader than any specific value". Either
--     incompatibility REFUSES the renewal
--     (catalog_terms_changed_incompatible_with_existing_entitlement)
--     rather than silently topping up an old entitlement under new,
--     incompatible terms. app.preview_package_renewal (below) surfaces
--     both as separate flags before the staff member ever attempts the
--     write.
--
-- Idempotency / concurrency (same shape as create_package_invoice /
-- repair_customer_package_balance, reviewed on this branch): the
-- customer_packages row is locked with SELECT ... FOR UPDATE FIRST, so a
-- retry/double-click/timeout-retry for the SAME package serializes on that
-- lock; by the time the second call reads public.invoices for the
-- request_key, the first call's invoice (if any) is already committed and
-- visible, so it is returned unchanged rather than re-created. The
-- idempotent-return check (review round 3, finding #1) compares EVERY
-- genuinely caller-supplied material input: the membership being renewed,
-- the branch, and the caller-supplied issued_at/due_at/normalized
-- admin_notes -- NOT the catalog's current price/sessions/rollover/expiry
-- terms, which are server-derived state that can legitimately drift
-- between the original call and a retry without making the retry
-- illegitimate (a genuine retry must still return its original result
-- after a later catalog change). A request key reused for a DIFFERENT
-- membership, branch, issued/due date, or admin note is rejected with a
-- single clear error; a plain retry with IDENTICAL inputs after a catalog
-- price change returns the original invoice unchanged, exactly as it
-- should.
--
-- Preview binding (review round 3, finding #2): a NEW renewal (one whose
-- request_key has no existing invoice yet) must supply
-- p_terms_fingerprint, computed by app.preview_package_renewal from the
-- SAME pkg/cp/reserved-count snapshot this function itself reads under the
-- row lock (app.fn_renewal_terms_fingerprint is a pure function of already-
-- fetched rows, not a second query, so there is no re-read race between
-- validating the fingerprint and using those exact values to compute the
-- charge). If the catalog/entitlement state has changed since the preview
-- was generated, the fingerprint will not match and the write is refused
-- (renewal_terms_changed_since_preview) -- the staff member must reload
-- the preview and re-confirm. An idempotent RETRY never re-checks the
-- fingerprint (it is not re-derivable from an already-issued invoice, and
-- re-checking it would defeat the "genuine retry survives a later catalog
-- change" guarantee above).
-- Order: lock -> authorize -> idempotent-return check -> business
-- validation (status/catalog-active/compatibility) -> fingerprint check ->
-- mutate.
-- ---------------------------------------------------------------------
drop function if exists app.renew_customer_package(uuid, uuid);
drop function if exists app.renew_customer_package(uuid, uuid, timestamptz, timestamptz, text, uuid);

-- Pure, query-free composition of the renewal terms fingerprint from
-- ALREADY-FETCHED pkg/cp rows plus an already-computed reserved-session
-- count -- never re-queried, so preview and renew always agree on exactly
-- the same snapshot they each already hold, with no TOCTOU window between
-- "check" and "use".
create or replace function app.fn_renewal_terms_fingerprint(pkg public.packages, cp public.customer_packages, p_reserved_count integer)
returns text
language sql immutable as $$
  select md5(concat_ws('|',
    pkg.id::text, pkg.price::text, pkg.currency, pkg.total_sessions::text, pkg.rollover_policy, pkg.recurrence_interval,
    pkg.per_pet::text, coalesce(pkg.service_id::text,'-'), pkg.is_active::text, coalesce(pkg.validity_days::text,'-'),
    cp.status, coalesce(cp.pet_id::text,'-'), coalesce(cp.service_id::text,'-'),
    coalesce(cp.expires_at::text,'-'), cp.sessions_remaining::text, p_reserved_count::text))
$$;

revoke all on function app.fn_renewal_terms_fingerprint(public.packages, public.customer_packages, integer) from public, authenticated;

create function app.renew_customer_package(
  p_customer_package uuid, p_branch uuid, p_issued_at timestamptz, p_due_at timestamptz,
  p_admin_notes text, p_request_key uuid, p_terms_fingerprint text)
returns public.invoices
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid; cp public.customer_packages; pkg public.packages; v_invoice public.invoices; v_order public.orders;
  v_new_expiry timestamptz; v_interval interval; v_number text; v_line_name text; v_normalized_notes text;
  v_reserved_count integer; v_unreserved_excess integer; v_pet_incompatible boolean; v_service_incompatible boolean;
begin
  v_org := app.fn_active_organization();
  if p_request_key is null or p_issued_at is null or (p_due_at is not null and p_due_at < p_issued_at) then
    raise exception 'invalid_invoice_details' using errcode = '22023';
  end if;
  v_normalized_notes := left(nullif(trim(p_admin_notes), ''), 2000);

  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_module('membership')
     or not app.has_permission('invoice.issue') or not app.has_permission('membership.manage') or not app.has_branch(p_branch) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into pkg from public.packages where organization_id = v_org and id = cp.package_id;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  select count(*) into v_reserved_count from public.package_reservations
   where organization_id = v_org and customer_package_id = cp.id and status = 'reserved';

  -- Idempotent return: same request_key must mean the SAME renewal request
  -- in full (see the comment block above this function).
  select * into v_invoice from public.invoices where organization_id = v_org and request_key = p_request_key;
  if found then
    if v_invoice.branch_id <> p_branch
       or v_invoice.metadata->>'renewal_of' is distinct from cp.id::text
       or v_invoice.issued_at <> p_issued_at
       or v_invoice.due_at is distinct from p_due_at
       or v_invoice.admin_notes is distinct from v_normalized_notes then
      raise exception 'request_key_reused_for_different_renewal' using errcode = '22023';
    end if;
    return v_invoice;
  end if;

  if cp.status = 'canceled' then raise exception 'package_canceled_cannot_renew' using errcode = 'check_violation'; end if;
  if not pkg.is_active then raise exception 'package_catalog_inactive' using errcode = 'check_violation'; end if;
  v_pet_incompatible := pkg.per_pet and cp.pet_id is null;
  v_service_incompatible := cp.service_id is not null and pkg.service_id is not null and cp.service_id <> pkg.service_id;
  if v_pet_incompatible or v_service_incompatible then
    raise exception 'catalog_terms_changed_incompatible_with_existing_entitlement' using errcode = 'check_violation';
  end if;

  if p_terms_fingerprint is null then raise exception 'renewal_preview_required' using errcode = '22023'; end if;
  if p_terms_fingerprint <> app.fn_renewal_terms_fingerprint(pkg, cp, v_reserved_count) then
    raise exception 'renewal_terms_changed_since_preview' using errcode = '40001';
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
    v_normalized_notes, p_request_key,
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

revoke all on function app.renew_customer_package(uuid, uuid, timestamptz, timestamptz, text, uuid, text) from public, authenticated;
grant execute on function app.renew_customer_package(uuid, uuid, timestamptz, timestamptz, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 3B — preview_package_renewal: READ-ONLY. Shows exactly what a
-- renewal would do (price, sessions to add, currency, pet/service scope,
-- resulting expiry, and whether the catalog's terms have drifted
-- incompatibly since this membership was sold) BEFORE the staff member
-- commits to the write, and returns the terms_fingerprint that
-- renew_customer_package requires for a new (non-retry) request. Never
-- writes; membership.read is sufficient.
-- ---------------------------------------------------------------------
create or replace function app.preview_package_renewal(p_customer_package uuid)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare
  v_org uuid; cp public.customer_packages; pkg public.packages;
  v_interval interval; v_new_expiry timestamptz; v_reserved_count integer; v_unreserved_excess integer;
  v_pet_incompatible boolean; v_service_incompatible boolean;
begin
  v_org := app.fn_active_organization();
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.read');

  select * into pkg from public.packages where organization_id = v_org and id = cp.package_id;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  select count(*) into v_reserved_count from public.package_reservations
   where organization_id = v_org and customer_package_id = cp.id and status = 'reserved';

  -- See the compatibility comment on renew_customer_package: optional pet
  -- binding on a per_pet=false sale is legitimate, so pet presence alone is
  -- never proof of drift; only the catalog NOW requiring a pet for a
  -- membership sold with none is unsafe. Service scope compares the
  -- catalog's current service_id against the immutable purchase-time
  -- snapshot cp.service_id; NULL on either side ("any service") is never a
  -- mismatch by itself.
  v_pet_incompatible := cp.status <> 'canceled' and pkg.per_pet and cp.pet_id is null;
  v_service_incompatible := cp.status <> 'canceled' and cp.service_id is not null and pkg.service_id is not null and cp.service_id <> pkg.service_id;

  v_interval := case pkg.recurrence_interval
    when 'week' then interval '7 days'
    when 'month' then interval '1 month'
    when 'year' then interval '1 year'
    else (coalesce(pkg.validity_days, 30) || ' days')::interval
  end;
  v_new_expiry := greatest(now(), coalesce(cp.expires_at, now())) + v_interval;
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
    'pet_scope_incompatible', v_pet_incompatible, 'service_scope_incompatible', v_service_incompatible,
    'incompatible', v_pet_incompatible or v_service_incompatible,
    'blocking_reason', case
      when cp.status = 'canceled' then 'package_canceled_cannot_renew'
      when not pkg.is_active then 'package_catalog_inactive'
      when v_pet_incompatible or v_service_incompatible then 'catalog_terms_changed_incompatible_with_existing_entitlement'
      else null
    end,
    'terms_fingerprint', app.fn_renewal_terms_fingerprint(pkg, cp, v_reserved_count),
    'generated_at', now());
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
--     void), a matching invoice_lines row for the same package_id with a
--     session snapshot equal to the ledger movement it produced (never
--     today's catalog sessions/price), AND -- review round 3, finding #4 --
--     the SPECIFIC membership: a 'purchase' row must point at exactly
--     cp.source_invoice_id, and a 'renewal' row's invoice must have
--     metadata->>'renewal_of' equal to THIS cp.id. Two separate purchases
--     of the same catalog package by the same customer (two different
--     customer_packages rows) must not be able to cross-link each other's
--     invoice and pass as "verified" merely by matching customer+product.
--   - The HISTORICAL source_invoice_id on customer_packages itself
--     (round 2 only checked it for NULL) is now validated the same way
--     when non-null: right customer, right package line, non-void status,
--     matching session snapshot -- as a read-only cross-check, never by
--     mutating the immutable purchase ledger row (invalid_source_invoice).
--   - The package's own source_invoice_id presence (legacy flag,
--     missing_source_invoice -- an explicit, disclosed "unknown
--     provenance" state, never silently treated as verified).
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
  v_invalid_source_invoice integer;
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
  -- Verify it actually belongs to THIS customer, is the CORRECT invoice for
  -- THIS SPECIFIC membership (not merely "same customer, same product" --
  -- two separate purchases of the same catalog package by the same
  -- customer must not pass by cross-linking each other's invoice), is not
  -- void, and its invoice line's snapshotted session count matches the
  -- ledger movement it produced (never today's catalog sessions/price).
  select count(*) into v_invalid_invoice_links
    from public.customer_package_ledger cpl
   where cpl.organization_id = v_org and cpl.customer_package_id = p_customer_package
     and cpl.reason in ('purchase', 'renewal') and cpl.invoice_id is not null
     and not exists (
       select 1 from public.invoices i
        join public.invoice_lines il
          on il.organization_id = v_org and il.invoice_id = i.id
         and il.item_type = 'package' and il.package_id = cp.package_id
        where i.organization_id = v_org and i.id = cpl.invoice_id
          and i.customer_id = cp.customer_id and i.status in ('issued', 'paid')
          and (il.pricing_breakdown->>'sessions')::numeric = cpl.delta
          and (
            (cpl.reason = 'purchase' and cpl.invoice_id = cp.source_invoice_id)
            -- Tied to the SPECIFIC renewal event, not merely "some invoice
            -- for this membership": two renewals of the same membership
            -- must not cross-link each other's invoice either. request_key
            -- is stamped identically onto both the invoice and its own
            -- renewal ledger row by renew_customer_package.
            or (cpl.reason = 'renewal' and i.metadata->>'renewal_of' = cp.id::text and i.request_key = cpl.request_key)
          )
     );

  -- The HISTORICAL purchase invoice (customer_packages.source_invoice_id,
  -- set once at purchase time, before invoice_id existed on the ledger
  -- itself) was previously checked only for NULL. A non-null value is now
  -- validated the same way: right customer, right package line, non-void
  -- status, and a matching session snapshot against the purchase ledger
  -- row -- WITHOUT mutating the immutable ledger row itself (this is a
  -- read-only cross-check, never a backfill/UPDATE).
  v_missing_source_invoice := cp.source_invoice_id is null;
  select count(*) into v_invalid_source_invoice
    from public.customer_packages self
   where self.id = cp.id and self.source_invoice_id is not null
     and not exists (
       select 1 from public.invoices i
        join public.invoice_lines il
          on il.organization_id = v_org and il.invoice_id = i.id
         and il.item_type = 'package' and il.package_id = cp.package_id
        join public.customer_package_ledger cpl
          on cpl.organization_id = v_org and cpl.customer_package_id = cp.id and cpl.reason = 'purchase'
        where i.organization_id = v_org and i.id = self.source_invoice_id
          and i.customer_id = cp.customer_id and i.status in ('issued', 'paid')
          and (il.pricing_breakdown->>'sessions')::numeric = cpl.delta
     );
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
  if v_invalid_source_invoice > 0 then v_manual_review := v_manual_review || jsonb_build_array('invalid_source_invoice'); end if;
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
    'invalid_source_invoice', v_invalid_source_invoice,
    'over_reserved', v_over_reserved,
    'expired_but_status_active', v_expired_status_mismatch,
    'manual_review_issues', v_manual_review,
    'checked_at', now());
end; $$;

revoke all on function app.reconcile_customer_package(uuid) from public, authenticated;
grant execute on function app.reconcile_customer_package(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 5 — update_customer_package_terms: guarded, audited correction
-- of a PURCHASED membership's own administrative terms (review round 3,
-- finding #5 -- the section 25 requirement the handoff had disclosed as
-- incomplete). This is deliberately narrow, matching the allowed-field
-- matrix below; it is NOT a general-purpose editor and never touches
-- money or the session ledger.
--
-- Allowed-field matrix:
--   - expires_at: always correctable while the membership is not
--     'canceled' (an archived membership is reactivated via
--     set_customer_package_status first, not edited while archived).
--     Correcting it never touches sessions_remaining/the ledger, and never
--     retroactively invalidates a past reservation (reserve_package_session
--     already re-checks expires_at live at reservation time; it does not
--     snapshot it onto the reservation row).
--   - pet_id / service_id: correctable ONLY while the entitlement has
--     never been touched -- no package_reservations row of ANY status has
--     ever existed for it, and it has never been renewed
--     (renewal_count = 0). Once a session has been reserved/consumed
--     against a specific pet/service scope, or the membership has been
--     billed again under that scope via a renewal invoice, retargeting it
--     would retroactively misrepresent what was actually sold and
--     consumed -- refused with a precise reason
--     (entitlement_scope_locked_after_first_reservation /
--     entitlement_scope_locked_after_renewal) rather than silently allowed
--     or silently ignored.
--   - Never editable here: sessions_remaining, package_id, customer_id,
--     source_invoice_id, or any invoice/ledger row (no balance edits, no
--     retroactive rewriting of invoice/ledger terms -- that is exactly
--     what this RPC refuses to do; a balance correction still only ever
--     goes through repair_customer_package_balance).
--
-- Guarded like every other write RPC on this branch: membership.manage,
-- row locked FIRST, revision-checked (40001 on a stale request, same as
-- repair_customer_package_balance), a mandatory non-empty reason, and a
-- full before/after audit row in timeline_events -- never silent.
-- ---------------------------------------------------------------------
create or replace function app.update_customer_package_terms(
  p_customer_package uuid, p_revision integer, p_reason text,
  p_expires_at timestamptz, p_pet uuid, p_service uuid)
returns public.customer_packages
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid; cp public.customer_packages; v_has_reservations boolean;
  v_pet_changed boolean; v_service_changed boolean;
begin
  v_org := app.fn_active_organization();
  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package for update;
  if not found then raise exception 'package_not_found' using errcode = 'no_data_found'; end if;

  perform app.assert_tenant_authorized(v_org, 'membership', 'membership.manage');

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'correction_reason_required' using errcode = 'check_violation';
  end if;
  if cp.revision <> p_revision then raise exception 'stale_correction_request' using errcode = '40001'; end if;
  if cp.status = 'canceled' then raise exception 'package_canceled_cannot_edit' using errcode = 'check_violation'; end if;

  v_pet_changed := p_pet is distinct from cp.pet_id;
  v_service_changed := p_service is distinct from cp.service_id;

  if v_pet_changed or v_service_changed then
    if cp.renewal_count > 0 then
      raise exception 'entitlement_scope_locked_after_renewal' using errcode = 'check_violation';
    end if;
    select exists(
      select 1 from public.package_reservations
       where organization_id = v_org and customer_package_id = cp.id
    ) into v_has_reservations;
    if v_has_reservations then
      raise exception 'entitlement_scope_locked_after_first_reservation' using errcode = 'check_violation';
    end if;
  end if;

  if v_pet_changed and p_pet is not null
     and not exists(select 1 from public.pets where organization_id = v_org and id = p_pet and customer_id = cp.customer_id and deleted_at is null) then
    raise exception 'pet_not_found_for_customer' using errcode = 'P0002';
  end if;
  if v_service_changed and p_service is not null
     and not exists(select 1 from public.service_catalog where organization_id = v_org and id = p_service and deleted_at is null) then
    raise exception 'service_not_found' using errcode = 'P0002';
  end if;

  update public.customer_packages
     set expires_at = p_expires_at, pet_id = p_pet, service_id = p_service, revision = revision + 1
   where id = cp.id;

  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'package', cp.id, app.fn_current_user_id(), 'membership.terms_corrected', 'membership.terms_corrected',
          jsonb_build_object(
            'reason', p_reason,
            'before', jsonb_build_object('expires_at', cp.expires_at, 'pet_id', cp.pet_id, 'service_id', cp.service_id),
            'after', jsonb_build_object('expires_at', p_expires_at, 'pet_id', p_pet, 'service_id', p_service)));

  select * into cp from public.customer_packages where organization_id = v_org and id = p_customer_package;
  return cp;
end; $$;

revoke all on function app.update_customer_package_terms(uuid, integer, text, timestamptz, uuid, uuid) from public, authenticated;
grant execute on function app.update_customer_package_terms(uuid, integer, text, timestamptz, uuid, uuid) to authenticated;

commit;
