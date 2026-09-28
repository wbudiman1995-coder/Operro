-- Sections 27-30 closeout — fixes from an external review of acf5268.
--
-- P3: retire the obsolete package-sale-outside-invoice path. This baseline
-- already has app.create_package_invoice (20260924120000_invoice_workflow.sql),
-- which atomically creates the order/invoice/invoice_line/customer_packages/
-- customer_package_ledger rows with request_key idempotency built in.
-- app.record_package_purchase_payment duplicated a second, worse billing
-- path (no ledger row, no idempotency beyond method/amount/customer, no
-- proof/review workflow) — drop it; app code is switched to
-- create_package_invoice + record_payment in the same closeout commit.
drop function if exists app.record_package_purchase_payment(uuid,uuid,uuid,text,numeric,text,uuid);

-- =====================================================================
-- S1: storage authorization gaps.
--
-- 1. The grooming-evidence read scope (20260929100000) never accounted for
--    the payment-proof path shape, so `{org}/payments/...` fell through to
--    "defer to the broader membership policy" comment while ACTUALLY being
--    caught by the 3-segment grooming-evidence branch (the old proof path
--    was `{org}/payments/{invoiceId}/{uuid}.ext`, 3 folder segments) and
--    denied to everyone without evidence.read_all — payment-proof access
--    was never actually governed by finance permissions at all. The proof
--    path is changed in the same closeout commit to
--    `{org}/payments/{requestKey}.ext` (2 folder segments, deterministic —
--    see P1), so this migration adds a real 2-segment payment-proof branch.
-- 2. Grooming evidence UPDATE/DELETE were never restricted beyond the
--    original org-folder + booking.update permissive policy — any org
--    member holding booking.update (i.e. every groomer) could overwrite or
--    delete another job's evidence file. Add the same assignment-scoped
--    restriction UPDATE/DELETE already has for SELECT.
-- 3. Payment-proof objects get their own UPDATE (always denied — proofs are
--    immutable once uploaded) and DELETE (allowed only pre-commit, i.e. no
--    payment row references the attachment yet) rules.
-- =====================================================================

drop policy if exists attachments_objects_read_evidence_scope on storage.objects;
drop function if exists app.fn_can_read_grooming_evidence(text);

create or replace function app.fn_can_read_payment_proof(p_name text)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_attachment_id uuid; v_branch uuid;
begin
  if not app.has_permission('finance.read') then return false; end if;
  select a.id into v_attachment_id from public.attachments a
    where a.organization_id = v_org and a.storage_path = p_name and a.deleted_at is null;
  if v_attachment_id is null then
    -- Nothing committed at this path yet (mid-upload) — only the uploader's
    -- own permission tier may see it.
    return app.has_permission('payment.manage');
  end if;
  select p.branch_id into v_branch from public.payments p
    where p.organization_id = v_org and p.proof_attachment_id = v_attachment_id;
  if v_branch is null then
    -- Linked to an invoice but no payment row committed yet.
    select i.branch_id into v_branch from public.attachment_links al
      join public.invoices i on i.organization_id = al.organization_id and i.id = al.subject_id
      where al.organization_id = v_org and al.attachment_id = v_attachment_id and al.subject_type = 'invoice'
      limit 1;
  end if;
  if v_branch is null then return false; end if;
  return app.has_branch(v_branch);
end $$;

create or replace function app.fn_can_delete_payment_proof(p_name text)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare v_org uuid := app.fn_active_organization(); v_attachment_id uuid;
begin
  if not app.has_permission('payment.manage') then return false; end if;
  select a.id into v_attachment_id from public.attachments a
    where a.organization_id = v_org and a.storage_path = p_name;
  if v_attachment_id is null then return true; end if; -- nothing committed at this path; safe pre-upload/orphan cleanup
  return not exists (select 1 from public.payments where organization_id = v_org and proof_attachment_id = v_attachment_id);
end $$;

create or replace function app.fn_attachments_object_readable(p_name text)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare v_segments text[]; v_job_pet_id uuid;
begin
  v_segments := storage.foldername(p_name);
  if array_length(v_segments,1) = 2 and v_segments[2] = 'payments' then
    return app.fn_can_read_payment_proof(p_name);
  end if;
  if array_length(v_segments,1) = 3 and v_segments[3] <> 'attendance' then
    if app.has_permission('evidence.read_all') then return true; end if;
    begin
      v_job_pet_id := v_segments[3]::uuid;
    exception when invalid_text_representation then
      return true; -- not a per-job-pet evidence path either; defer to the broader membership policy
    end;
    return exists (
      select 1 from public.grooming_job_pets gjp
      join public.resources r on r.organization_id = gjp.organization_id and r.id = gjp.assigned_resource_id
      join public.memberships m on m.organization_id = r.organization_id and m.id = r.membership_id
      where gjp.organization_id = app.fn_active_organization() and gjp.id = v_job_pet_id
        and m.user_id = auth.uid() and m.status = 'active' and m.deleted_at is null
    );
  end if;
  return true; -- attendance and any other shape: defer to the broader membership policy
end $$;

create policy attachments_objects_read_scoped on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'attachments' or app.fn_attachments_object_readable(name));

-- Assignment-scoped UPDATE/DELETE for grooming evidence. Payment-proof paths
-- are explicitly excluded here (`(storage.foldername(name))[2] = 'payments'`
-- short-circuits to "not restricted by THIS policy") because they get their
-- own, stricter rules immediately below — reusing the read-scope function
-- for a write would only prove "readable", not "writable by this actor".
create policy attachments_objects_write_upd_evidence_scope on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'attachments' or (storage.foldername(name))[2] = 'payments' or app.fn_attachments_object_readable(name));

create policy attachments_objects_write_del_evidence_scope on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'attachments' or (storage.foldername(name))[2] = 'payments' or app.fn_attachments_object_readable(name));

-- Payment-proof objects: never updatable once uploaded, deletable only
-- pre-commit (no payment references them yet).
create policy attachments_objects_write_upd_payment_proof on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'attachments' or (storage.foldername(name))[2] <> 'payments');

create policy attachments_objects_write_del_payment_proof on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'attachments' or (storage.foldername(name))[2] <> 'payments' or app.fn_can_delete_payment_proof(name));

-- =====================================================================
-- app.delete_grooming_evidence must verify the attachment IS grooming
-- evidence (a real category + linked to a booking) before deleting — today
-- an evidence.read_all/booking.delete holder could pass ANY attachment id,
-- including a payment proof, and it would be deleted unconditionally.
-- =====================================================================
create or replace function app.delete_grooming_evidence(p_attachment uuid)
returns table (storage_bucket text, storage_path text) language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_attachment public.attachments;
  v_link public.attachment_links;
  v_category text;
  v_job_pet_id uuid;
  v_membership_id uuid;
  v_authorized boolean := false;
begin
  if v_org is null or not app.has_membership() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_attachment from public.attachments where organization_id = v_org and id = p_attachment and deleted_at is null for update;
  if not found then raise exception 'attachment_not_found' using errcode = 'P0002'; end if;

  v_category := nullif(v_attachment.metadata->>'category', '');
  select * into v_link from public.attachment_links where organization_id = v_org and attachment_id = p_attachment and subject_type = 'booking' limit 1;
  if v_category is null or v_category not in ('before','after','attendance','ear','hygiene','dematting','fungal','injury','other') or not found then
    raise exception 'not_grooming_evidence' using errcode = '22023';
  end if;

  if app.has_permission('evidence.read_all') or app.has_permission('booking.delete') then
    v_authorized := true;
  else
    v_job_pet_id := nullif(v_attachment.metadata->>'grooming_job_pet_id','')::uuid;
    if v_job_pet_id is not null then
      select m.id into v_membership_id from public.memberships m
        where m.organization_id = v_org and m.user_id = auth.uid() and m.status = 'active' and m.deleted_at is null;
      v_authorized := v_membership_id is not null and exists (
        select 1 from public.grooming_job_pets gjp join public.resources r
          on r.organization_id = gjp.organization_id and r.id = gjp.assigned_resource_id
        where gjp.organization_id = v_org and gjp.id = v_job_pet_id and r.membership_id = v_membership_id
      );
    end if;
  end if;
  if not v_authorized then raise exception 'not_authorized' using errcode = '42501'; end if;

  update public.attachments set deleted_at = now(), updated_by = auth.uid() where id = p_attachment;
  insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  values (v_org, v_link.subject_type, v_link.subject_id, auth.uid(), 'evidence.deleted', 'Grooming evidence photo removed', jsonb_build_object('attachment_id', p_attachment));
  return query select v_attachment.storage_bucket, v_attachment.storage_path;
end $$;

notify pgrst, 'reload schema';
