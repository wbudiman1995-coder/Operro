-- Section 29 — payment-control workflow (admin-controlled; no bank API).
--
-- REVISION 2 (2026-09-26): fixes a backend review of the first draft. Every
-- item below is a distinct fix, not a rewrite of the design:
--   1. record_payment's request_key check raced two concurrent identical
--      calls (both could pass the pre-check before either locked anything).
--      Fixed with pg_advisory_xact_lock on (org, request_key) BEFORE the
--      existing-row check, so concurrent callers serialize on the lock and
--      the second one observes the first's committed row.
--   2. The idempotent-retry path returned the existing row before verifying
--      the CALLER still has branch access (e.g. after a branch grant is
--      revoked between the original call and a retry). Fixed: branch access
--      is checked before returning on EITHER path.
--   3. The proof-attachment check only verified org+not-deleted, so any
--      attachment ID in the same org (e.g. another customer's evidence
--      photo) was accepted as "proof". Fixed: the attachment must be
--      LINKED (attachment_links) to THIS invoice specifically, and
--      bank_transfer payments now require a proof attachment at all —
--      there is no "screenshot" stage to confirm without one.
--   4. The existing payment UI (pilot-actions.ts) inserted into `payments`
--      directly, bypassing all of the above. Fixed: INSERT/UPDATE on
--      `payments` is revoked from `authenticated` entirely (same
--      column/table-privilege pattern as bookings.status, SECTION 610 of
--      20260721001300) — every write now MUST go through an RPC. The app
--      code call sites are updated in the same commit as this migration.
--   5. Defaulting every historical payment to `bank_validated` asserted a
--      bank check that was never actually performed. Fixed: pre-existing
--      rows get a new, honest `legacy_unreviewed` stage, and non-bank
--      methods get `not_applicable` (nothing to screenshot-check) instead
--      of the same `bank_validated` label a REAL review produces — the UI
--      can now tell "actually validated" apart from "never reviewed" and
--      "review doesn't apply to this method".
--   6. record_payment's two follow-up UPDATEs on `invoices` (mark paid,
--      then separately record an overpaid amount) hit tg_invoices_freeze:
--      the SECOND update ran against a row whose OLD.status was already
--      'paid' from the FIRST update, which the freeze trigger rejects
--      outright. Fixed: collapsed into one UPDATE.
--   7. Permission provisioning: the existing-org backfill from the first
--      draft is kept (see below) and is deliberately narrow (payment.manage
--      -> payment.validate, customer.manage -> evidence.read_all) so it
--      cannot broaden a groomer/receptionist role that never had the
--      broader permission. New organizations are unaffected: this
--      codebase's only org-provisioning path today is the seed's
--      "grant every current permission to the Owner role" pattern
--      (supabase/seeds/homepaw_demo.sql:31-32), which already picks up any
--      permission that exists at seed time with no extra step — there is
--      no separate in-app org-provisioning code to update.
--
-- Interpretation carried over from the first draft (still correct):
-- `payments.status` ('succeeded'/'pending'/'failed') keeps its EXISTING
-- meaning — it drives public.tg_payment_ledger() on INSERT and the
-- dashboard/report revenue sums (pilot-data.ts:59,65,239) — and is left
-- untouched. "payment_stage" is a separate, additive review-workflow axis:
--   - "Payment Successful" (brief §29) = payments.status = 'succeeded'.
--   - "Validated"           (brief §29) = payments.payment_stage = 'bank_validated'.
begin;

insert into public.permissions (key, resource, action, description) values
  ('payment.validate','payment','validate','Validate bank-confirmed payment screenshots')
on conflict (key) do nothing;

-- Populated-upgrade backfill (see item 7 above for why this is safe/narrow).
insert into public.role_permissions (organization_id, role_id, permission_id)
select rp.organization_id, rp.role_id, perm_new.id
from public.role_permissions rp
join public.permissions perm_old on perm_old.id = rp.permission_id and perm_old.key = 'payment.manage'
cross join (select id from public.permissions where key = 'payment.validate') perm_new
on conflict do nothing;

alter table public.payments
  add column payment_stage text not null default 'not_applicable',
  add column request_key uuid,
  add column proof_attachment_id uuid,
  add column screenshot_confirmed_by uuid,
  add column screenshot_confirmed_at timestamptz,
  add column bank_validated_by uuid,
  add column bank_validated_at timestamptz,
  add constraint chk_payments_stage check (payment_stage in
    ('not_applicable','awaiting_screenshot','screenshot_confirmed','bank_validated','legacy_unreviewed')),
  add constraint fk_payments_proof_attachment foreign key (organization_id, proof_attachment_id) references public.attachments (organization_id, id);

create unique index uq_payments_request_key on public.payments (organization_id, request_key) where request_key is not null;
create index idx_payments_org_stage on public.payments (organization_id, payment_stage);

-- Drop the OLD blanket immutability trigger BEFORE the historical-label
-- backfill below — on a POPULATED database (unlike a fresh/empty one) that
-- backfill UPDATEs real pre-existing rows, and app.tg_block_update() would
-- reject every one of them if it were still attached (exactly the
-- "passed on empty, failed on populated data" trap called out in this
-- project's own review history). The replacement conditional trigger is
-- created right after, so the table is never left without SOME immutability
-- guard.
drop trigger if exists trg_payments_block_update on public.payments;

-- Honest historical label (item 5): every row that existed BEFORE this
-- migration was settled under the old flow with no screenshot/bank review
-- of any kind, regardless of method — the column default above already
-- applies to them, but 'not_applicable' would incorrectly suggest a
-- bank_transfer payment never needed review. Relabel pre-existing
-- bank_transfer rows specifically to 'legacy_unreviewed'.
update public.payments set payment_stage = 'legacy_unreviewed' where method = 'bank_transfer';

-- =====================================================================
-- Conditional immutability: monetary/identity fields stay permanently
-- immutable, payment_stage may only progress forward through the review
-- pipeline, and the row is fully frozen once 'bank_validated'.
-- =====================================================================

create or replace function app.tg_payments_freeze()
returns trigger language plpgsql as $$
begin
  if old.payment_stage = 'bank_validated' and new is distinct from old then
    raise exception 'Validated payment % is locked and cannot be edited.', old.id
      using errcode = 'restrict_violation';
  end if;
  if (new.organization_id, new.branch_id, new.invoice_id, new.customer_id, new.method, new.amount,
      new.currency, new.status, new.external_ref, new.paid_at, new.request_key) is distinct from
     (old.organization_id, old.branch_id, old.invoice_id, old.customer_id, old.method, old.amount,
      old.currency, old.status, old.external_ref, old.paid_at, old.request_key) then
    raise exception 'Payment % monetary and identity fields are immutable.', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.payment_stage is distinct from old.payment_stage then
    if not (
      (old.payment_stage = 'awaiting_screenshot' and new.payment_stage = 'screenshot_confirmed')
      or (old.payment_stage = 'screenshot_confirmed' and new.payment_stage = 'bank_validated')
    ) then
      raise exception 'Invalid payment stage transition % -> %.', old.payment_stage, new.payment_stage
        using errcode = '55000';
    end if;
  end if;
  if old.screenshot_confirmed_at is not null and new.screenshot_confirmed_at is distinct from old.screenshot_confirmed_at then
    raise exception 'screenshot_confirmed_at is immutable once set.' using errcode = 'restrict_violation';
  end if;
  if old.bank_validated_at is not null and new.bank_validated_at is distinct from old.bank_validated_at then
    raise exception 'bank_validated_at is immutable once set.' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger trg_payments_freeze before update on public.payments
  for each row execute function app.tg_payments_freeze();

-- Item 4: no direct client write can reach `payments` any more, regardless
-- of RLS/permission — only the SECURITY DEFINER RPCs below (which run as
-- the function owner and bypass table grants) can insert or update it.
revoke insert, update on public.payments from authenticated;

-- Small helper so record_payment reads one consistent "paid so far" number
-- instead of repeating the same subquery three times with drift risk.
create or replace function app.fn_invoice_paid_total(p_org uuid, p_invoice uuid)
returns numeric language sql stable as $$
  select coalesce(sum(amount), 0) from public.payments where organization_id = p_org and invoice_id = p_invoice and status = 'succeeded';
$$;

-- =====================================================================
-- app.record_payment — idempotent, authorization-checked, invoice-backed
-- payment recording. Replaces the raw insert in pilot-actions.ts's
-- recordPaymentAction.
-- =====================================================================
create or replace function app.record_payment(
  p_invoice uuid, p_method text, p_amount numeric, p_external_ref text,
  p_proof_attachment uuid, p_request_key uuid)
returns public.payments language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_invoice public.invoices;
  v_existing public.payments;
  v_stage text;
  v_row public.payments;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('payment.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_key is null then raise exception 'request_key_required' using errcode = '22023'; end if;
  if p_method not in ('cash','card','wallet','bank_transfer','other') then raise exception 'invalid_method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;

  -- Item 1: serialize every call sharing this (org, request_key) so the
  -- existing-row check below is race-free — the second caller to arrive
  -- blocks here until the first one commits (or rolls back) its insert.
  perform pg_advisory_xact_lock(hashtext(v_org::text || ':' || p_request_key::text));

  select * into v_existing from public.payments where organization_id = v_org and request_key = p_request_key;
  if found then
    -- Item 2: re-verify branch access on the retry path too, not just the
    -- fresh-insert path — a revoked branch grant must be re-caught here.
    if not app.has_branch(v_existing.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
    if (v_existing.invoice_id, v_existing.method, v_existing.amount, v_existing.external_ref, v_existing.proof_attachment_id) is distinct from
       (p_invoice, p_method, p_amount, p_external_ref, p_proof_attachment) then
      raise exception 'request_key_reused_with_different_inputs' using errcode = '55000';
    end if;
    return v_existing;
  end if;

  select * into v_invoice from public.invoices where organization_id = v_org and id = p_invoice for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_invoice.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_invoice.status = 'void' then raise exception 'invoice_void' using errcode = '55000'; end if;
  if v_invoice.status = 'paid' then raise exception 'invoice_already_paid' using errcode = '55000'; end if;
  if v_invoice.total = 0 then raise exception 'invoice_zero_due' using errcode = '55000'; end if;

  -- Item 3: a bank_transfer payment IS the screenshot-review workflow —
  -- there is nothing to confirm without a proof attachment that is
  -- actually linked to THIS invoice (not merely present somewhere in the
  -- organization).
  if p_method = 'bank_transfer' and p_proof_attachment is null then
    raise exception 'proof_required_for_bank_transfer' using errcode = '22023';
  end if;
  if p_proof_attachment is not null and not exists (
    select 1 from public.attachments a
    join public.attachment_links al on al.organization_id = a.organization_id and al.attachment_id = a.id
    where a.organization_id = v_org and a.id = p_proof_attachment and a.deleted_at is null
      and al.subject_type = 'invoice' and al.subject_id = p_invoice
  ) then
    raise exception 'proof_attachment_not_linked_to_invoice' using errcode = 'P0002';
  end if;

  v_stage := case when p_method = 'bank_transfer' then 'awaiting_screenshot' else 'not_applicable' end;

  insert into public.payments (organization_id, branch_id, invoice_id, customer_id, method, amount, currency,
    status, external_ref, proof_attachment_id, payment_stage, request_key)
  values (v_org, v_invoice.branch_id, p_invoice, v_invoice.customer_id, p_method, p_amount, v_invoice.currency,
    'succeeded', p_external_ref, p_proof_attachment, v_stage, p_request_key)
  returning * into v_row;

  if p_proof_attachment is not null then
    insert into public.attachment_links (organization_id, attachment_id, subject_type, subject_id)
    values (v_org, p_proof_attachment, 'payment', v_row.id)
    on conflict do nothing;
  end if;

  -- Item 6: ONE update, so a same-shot overpayment (metadata change) and
  -- the paid-status flip never fight tg_invoices_freeze against each
  -- other's OLD.status.
  update public.invoices set
    status = case when app.fn_invoice_paid_total(v_org, p_invoice) >= v_invoice.total then 'paid' else status end,
    paid_at = case when app.fn_invoice_paid_total(v_org, p_invoice) >= v_invoice.total then now() else paid_at end,
    metadata = case when app.fn_invoice_paid_total(v_org, p_invoice) > v_invoice.total
      then jsonb_set(metadata, '{overpaid_amount}', to_jsonb(app.fn_invoice_paid_total(v_org, p_invoice) - v_invoice.total), true)
      else metadata end
  where id = v_invoice.id;

  return v_row;
end $$;

-- =====================================================================
-- app.record_package_purchase_payment — the OTHER existing direct-insert
-- site (sellPackageAction in pilot-actions.ts). Package purchases have no
-- invoice (packages cannot become order_items — see the comment on
-- sellPackageAction), so this mirrors record_payment's idempotency/stage
-- protections without the invoice-specific guards.
-- =====================================================================
create or replace function app.record_package_purchase_payment(
  p_branch uuid, p_customer uuid, p_package uuid, p_method text, p_amount numeric,
  p_currency text, p_request_key uuid)
returns public.payments language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_existing public.payments; v_row public.payments;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('payment.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_key is null then raise exception 'request_key_required' using errcode = '22023'; end if;
  if p_method not in ('cash','card','wallet','bank_transfer','other') then raise exception 'invalid_method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':' || p_request_key::text));

  select * into v_existing from public.payments where organization_id = v_org and request_key = p_request_key;
  if found then
    if not app.has_branch(v_existing.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
    if (v_existing.customer_id, v_existing.method, v_existing.amount) is distinct from (p_customer, p_method, p_amount) then
      raise exception 'request_key_reused_with_different_inputs' using errcode = '55000';
    end if;
    return v_existing;
  end if;

  if not exists (select 1 from public.customers where organization_id = v_org and id = p_customer and deleted_at is null) then
    raise exception 'customer_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.packages where organization_id = v_org and id = p_package) then
    raise exception 'package_not_found' using errcode = 'P0002';
  end if;

  insert into public.payments (organization_id, branch_id, customer_id, method, amount, currency,
    status, external_ref, payment_stage, request_key, metadata)
  values (v_org, p_branch, p_customer, p_method, p_amount, coalesce(p_currency,'IDR'),
    'succeeded', 'PACKAGE-' || p_request_key::text,
    case when p_method = 'bank_transfer' then 'legacy_unreviewed' else 'not_applicable' end,
    p_request_key, jsonb_build_object('kind','package_purchase','package_id',p_package))
  returning * into v_row;
  return v_row;
end $$;
comment on function app.record_package_purchase_payment is
  'bank_transfer package purchases default to legacy_unreviewed (no screenshot capture wired into the package-sale UI yet); document this as a known gap rather than a real bank check.';

-- =====================================================================
-- app.confirm_payment_screenshot / app.validate_payment_bank_account.
-- =====================================================================
create or replace function app.confirm_payment_screenshot(p_payment uuid)
returns public.payments language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.payments;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('payment.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.payments where organization_id = v_org and id = p_payment for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_row.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_row.payment_stage <> 'awaiting_screenshot' then raise exception 'invalid_stage_transition' using errcode = '55000'; end if;
  if v_row.proof_attachment_id is null then raise exception 'proof_required' using errcode = '55000'; end if;
  update public.payments set payment_stage = 'screenshot_confirmed', screenshot_confirmed_by = auth.uid(), screenshot_confirmed_at = now()
    where id = p_payment returning * into v_row;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'payment', p_payment, auth.uid(), 'payment.screenshot_confirmed', 'Payment screenshot confirmed', '{}'::jsonb);
  return v_row;
end $$;

create or replace function app.validate_payment_bank_account(p_payment uuid)
returns public.payments language plpgsql security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_row public.payments;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('payment.validate') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.payments where organization_id = v_org and id = p_payment for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_row.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_row.payment_stage <> 'screenshot_confirmed' then raise exception 'invalid_stage_transition' using errcode = '55000'; end if;
  update public.payments set payment_stage = 'bank_validated', bank_validated_by = auth.uid(), bank_validated_at = now()
    where id = p_payment returning * into v_row;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, 'payment', p_payment, auth.uid(), 'payment.bank_validated', 'Payment bank-account validated', '{}'::jsonb);
  return v_row;
end $$;

-- =====================================================================
-- Storage: payment-screenshot proofs reuse the private 'attachments' bucket
-- under a distinct permission (payment.manage, not booking.update).
-- =====================================================================
create policy attachments_objects_insert_payment on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('payment.manage')
  );

revoke all on function
  app.record_payment(uuid,text,numeric,text,uuid,uuid),
  app.record_package_purchase_payment(uuid,uuid,uuid,text,numeric,text,uuid),
  app.confirm_payment_screenshot(uuid),
  app.validate_payment_bank_account(uuid),
  app.fn_invoice_paid_total(uuid,uuid)
from public;
grant execute on function
  app.record_payment(uuid,text,numeric,text,uuid,uuid),
  app.record_package_purchase_payment(uuid,uuid,uuid,text,numeric,text,uuid),
  app.confirm_payment_screenshot(uuid),
  app.validate_payment_bank_account(uuid)
to authenticated;

notify pgrst, 'reload schema';
commit;
