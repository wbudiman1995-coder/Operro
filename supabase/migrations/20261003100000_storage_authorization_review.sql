-- Sections 27-30 final closeout — S1 review findings on the storage
-- authorization migration (20261001100000_payment_workflow_closeout.sql):
--
-- 1. fn_attachments_object_readable classified an object by PATH SHAPE
--    (segment count) rather than its actual recorded purpose. A forged or
--    unusual path could dodge the payment-proof/grooming-evidence branches
--    entirely and land in the catch-all `return true`. Rewritten to resolve
--    the attachment's real category from public.attachments.metadata (the
--    canonical record of what an object IS), looked up by storage_path —
--    path shape can no longer be used to reclassify an object.
-- 2. The evidence.read_all fast path (both in the storage read function and
--    in delete_grooming_evidence) granted access without checking whether
--    the caller can access the BRANCH the evidence's booking belongs to.
--    Every other org-wide read permission in this app is branch-scoped
--    (booking.read via the base bookings_branch_isolation policy, etc.) —
--    evidence.read_all was the one exception, letting a branch-restricted
--    membership with evidence.read_all see/delete evidence from branches
--    they otherwise cannot touch. Now checks app.has_branch() against the
--    resolved booking branch, same as the assigned-groomer path already did
--    implicitly through the resource/membership join.
begin;

create or replace function app.fn_attachments_object_readable(p_name text)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_attachment public.attachments;
  v_category text;
  v_job_pet_id uuid;
  v_booking_branch uuid;
begin
  if v_org is null or not app.has_membership() then return false; end if;
  if (storage.foldername(p_name))[1] is distinct from v_org::text then return false; end if;

  select * into v_attachment from public.attachments where organization_id = v_org and storage_path = p_name and deleted_at is null;
  if not found then
    -- Nothing committed at this path yet (mid-upload race, between the
    -- storage upload and the attachments insert). Path shape is the only
    -- signal available at this point, which is fine here specifically
    -- because it can only ever WIDEN a race window of a few hundred
    -- milliseconds, never reclassify a COMMITTED object.
    if (storage.foldername(p_name))[2] = 'payments' then
      return app.has_permission('payment.manage');
    end if;
    return true;
  end if;

  v_category := nullif(v_attachment.metadata->>'category', '');

  if v_category = 'payment_proof' then
    return app.fn_can_read_payment_proof(p_name);
  end if;

  if v_category in ('before','after','ear','hygiene','dematting','fungal','injury','other') then
    v_job_pet_id := nullif(v_attachment.metadata->>'grooming_job_pet_id', '')::uuid;
    if v_job_pet_id is not null then
      select b.branch_id into v_booking_branch
        from public.grooming_job_pets gjp
        join public.bookings b on b.organization_id = gjp.organization_id and b.id = gjp.grooming_job_id
        where gjp.organization_id = v_org and gjp.id = v_job_pet_id;
    end if;
    if app.has_permission('evidence.read_all') then
      -- evidence.read_all means "across all JOBS", not "across all
      -- branches" — bounded to branches the caller can access, same as
      -- every other org-wide read permission in this app.
      return v_booking_branch is null or app.has_branch(v_booking_branch);
    end if;
    if v_job_pet_id is null then return false; end if;
    return exists (
      select 1 from public.grooming_job_pets gjp
      join public.resources r on r.organization_id = gjp.organization_id and r.id = gjp.assigned_resource_id
      join public.memberships m on m.organization_id = r.organization_id and m.id = r.membership_id
      where gjp.organization_id = v_org and gjp.id = v_job_pet_id
        and m.user_id = auth.uid() and m.status = 'active' and m.deleted_at is null
    );
  end if;

  if v_category = 'attendance' then return true; end if; -- internal, org-wide, unchanged from before this migration

  -- Every other category this migration does not narrow (brand_logo,
  -- styling reference, onboarding upload, ...): unchanged pre-existing
  -- behavior, deferring to the base membership policy.
  return true;
end $$;

-- app.delete_grooming_evidence: same branch-scoping fix for its
-- evidence.read_all/booking.delete fast path.
create or replace function app.delete_grooming_evidence(p_attachment uuid)
returns table (storage_bucket text, storage_path text) language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_attachment public.attachments;
  v_link public.attachment_links;
  v_category text;
  v_job_pet_id uuid;
  v_membership_id uuid;
  v_booking_branch uuid;
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

  select b.branch_id into v_booking_branch from public.bookings b where b.organization_id = v_org and b.id = v_link.subject_id;

  if app.has_permission('evidence.read_all') or app.has_permission('booking.delete') then
    v_authorized := v_booking_branch is null or app.has_branch(v_booking_branch);
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
commit;
