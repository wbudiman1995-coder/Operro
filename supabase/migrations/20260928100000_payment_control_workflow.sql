-- Section 29 — payment-control workflow (admin-controlled; no bank API).
--
-- Interpretation recorded explicitly (see docs/handoffs/S27-S30-HANDOFF.md):
-- `payments.status` ('succeeded'/'pending'/'failed') keeps its EXISTING meaning
-- and is left untouched — it already drives public.tg_payment_ledger() on INSERT
-- (20260721000800_financial_sales.sql) and the dashboard/report revenue sums
-- (apps/web/src/lib/pilot-data.ts:59,65,239). Re-purposing it to gate on the new
-- screenshot/bank-validation review would silently delay ledger recognition
-- (the ledger trigger only fires on INSERT, not UPDATE) and was rejected as an
-- unacceptable regression risk to already-tested revenue recognition.
--
-- Instead, "payment_stage" is a genuinely new, independent review-workflow axis
-- layered on top of the existing succeeded/pending/failed payment record:
--   - "Payment Successful" (brief §29) = payments.status = 'succeeded' (unchanged).
--   - "Validated"           (brief §29) = payments.payment_stage = 'bank_validated'.
-- Cash/card/wallet payments have nothing to screenshot-check, so they start (and
-- stay) at 'bank_validated' — there is no pending review queue for them.
begin;

insert into public.permissions (key, resource, action, description) values
  ('payment.validate','payment','validate','Validate bank-confirmed payment screenshots')
on conflict (key) do nothing;

-- Populated-upgrade backfill: a brand-new permission is never auto-granted to
-- existing roles (each org's owner must ordinarily assign it deliberately).
-- For THIS permission specifically, silently leaving every existing role
-- without it would mean no one at any already-running org could ever reach
-- 'bank_validated' after this upgrade — not a safer default, just a stuck
-- payment queue discovered in production. Preserve today's capability level
-- by granting it to whichever roles already hold 'payment.manage' (whoever
-- could record/manage payments before this upgrade keeps full control of the
-- workflow after it); anyone without payment.manage today gains nothing new.
insert into public.role_permissions (organization_id, role_id, permission_id)
select rp.organization_id, rp.role_id, perm_new.id
from public.role_permissions rp
join public.permissions perm_old on perm_old.id = rp.permission_id and perm_old.key = 'payment.manage'
cross join (select id from public.permissions where key = 'payment.validate') perm_new
on conflict do nothing;

alter table public.payments
  add column payment_stage text not null default 'bank_validated',
  add column request_key uuid,
  add column proof_attachment_id uuid,
  add column screenshot_confirmed_by uuid,
  add column screenshot_confirmed_at timestamptz,
  add column bank_validated_by uuid,
  add column bank_validated_at timestamptz,
  add constraint chk_payments_stage check (payment_stage in ('awaiting_screenshot','screenshot_confirmed','bank_validated')),
  add constraint fk_payments_proof_attachment foreign key (organization_id, proof_attachment_id) references public.attachments (organization_id, id);

create unique index uq_payments_request_key on public.payments (organization_id, request_key) where request_key is not null;
create index idx_payments_org_stage on public.payments (organization_id, payment_stage);

-- Existing rows (all methods, including bank_transfer) predate the stage
-- column and were recorded under the old flow with no screenshot review at
-- all; the `not null default 'bank_validated'` above already backfills every
-- pre-existing row to the terminal stage, so no false "awaiting screenshot"
-- queue appears for money already settled before this migration.

-- =====================================================================
-- Replace the blanket immutability trigger with a conditional one: the
-- monetary/identity fields stay permanently immutable (same guarantee as
-- before), but payment_stage may progress forward through the three stages,
-- and is fully frozen (like tg_invoices_freeze) once 'bank_validated'.
-- =====================================================================
drop trigger if exists trg_payments_block_update on public.payments;

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

-- =====================================================================
-- app.record_payment — idempotent (request_key), authorization-checked
-- replacement for the raw `supabase.from("payments").insert(...)` in
-- apps/web/src/app/pilot-actions.ts:740-752. Sets the initial payment_stage
-- by method and enforces the invoice-state guards the brief calls out.
-- =====================================================================
create or replace function app.record_payment(
  p_invoice uuid, p_method text, p_amount numeric, p_external_ref text,
  p_proof_attachment uuid, p_request_key uuid)
returns public.payments language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_invoice public.invoices;
  v_existing public.payments;
  v_paid_so_far numeric(14,2);
  v_stage text;
  v_row public.payments;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('payment.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_key is null then raise exception 'request_key_required' using errcode = '22023'; end if;
  if p_method not in ('cash','card','wallet','bank_transfer','other') then raise exception 'invalid_method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;

  select * into v_existing from public.payments where organization_id = v_org and request_key = p_request_key;
  if found then
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
  if p_proof_attachment is not null and not exists (
    select 1 from public.attachments where organization_id = v_org and id = p_proof_attachment and deleted_at is null
  ) then
    raise exception 'proof_attachment_not_found' using errcode = 'P0002';
  end if;

  v_stage := case when p_method = 'bank_transfer' then 'awaiting_screenshot' else 'bank_validated' end;

  insert into public.payments (organization_id, branch_id, invoice_id, customer_id, method, amount, currency,
    status, external_ref, proof_attachment_id, payment_stage, request_key)
  values (v_org, v_invoice.branch_id, p_invoice, v_invoice.customer_id, p_method, p_amount, v_invoice.currency,
    'succeeded', p_external_ref, p_proof_attachment, v_stage, p_request_key)
  returning * into v_row;

  select coalesce(sum(amount), 0) into v_paid_so_far from public.payments
    where organization_id = v_org and invoice_id = p_invoice and status = 'succeeded';
  if v_paid_so_far >= v_invoice.total and v_invoice.status <> 'paid' then
    update public.invoices set status = 'paid', paid_at = now() where id = v_invoice.id;
  end if;
  if v_paid_so_far > v_invoice.total then
    update public.invoices set metadata = jsonb_set(metadata, '{overpaid_amount}', to_jsonb(v_paid_so_far - v_invoice.total), true)
      where id = v_invoice.id;
  end if;

  return v_row;
end $$;

-- =====================================================================
-- app.confirm_payment_screenshot / app.validate_payment_bank_account —
-- the two admin review steps. Bank validation requires the stricter
-- 'payment.validate' permission (distinct from ordinary 'payment.manage'),
-- matching the brief's "admin-controlled" separation.
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
-- Storage: payment-screenshot proofs reuse the existing private 'attachments'
-- bucket (20260918130000_grooming_evidence_storage.sql) under a distinct
-- permission — payment.manage, not booking.update — for the same org-folder
-- path convention. Permissive policies OR together, so this only ADDS a way
-- in; it never widens the existing booking-evidence policies.
-- =====================================================================
create policy attachments_objects_insert_payment on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and app.has_permission('payment.manage')
  );

revoke all on function
  app.record_payment(uuid,text,numeric,text,uuid,uuid),
  app.confirm_payment_screenshot(uuid),
  app.validate_payment_bank_account(uuid)
from public;
grant execute on function
  app.record_payment(uuid,text,numeric,text,uuid,uuid),
  app.confirm_payment_screenshot(uuid),
  app.validate_payment_bank_account(uuid)
to authenticated;

notify pgrst, 'reload schema';
commit;
