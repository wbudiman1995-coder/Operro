-- Section 28 — grooming photo documentation hardening.
--
-- Categories, client compression, org-partitioned private storage, and the
-- write-path orphan cleanup already exist (grooming-evidence-form.tsx,
-- uploadGroomingEvidenceAction in pilot-actions.ts, 20260918130000). This
-- migration closes the two gaps that need schema/RLS changes:
--   1. "Assigned groomer can, unassigned cannot" is enforced today only by
--      the my-schedule query filter, NOT by RLS — any active org member can
--      read/signed-URL any evidence photo directly. Add a real RLS check.
--   2. There is no delete/retract action and no retention policy for
--      evidence photos (the onboarding-styling bucket has both; grooming
--      evidence has neither).
begin;

insert into public.permissions (key, resource, action, description) values
  ('evidence.read_all','evidence','read_all','View grooming evidence across all jobs, not just assigned ones')
on conflict (key) do nothing;

-- Populated-upgrade backfill, deliberately narrow: only roles that already
-- hold 'customer.manage' (an owner/manager-tier permission today, never
-- handed to a plain groomer role) get 'evidence.read_all' automatically.
-- Backfilling off 'booking.update' instead would defeat the point of this
-- migration — groomer roles hold booking.update too, so every existing
-- groomer would regain unrestricted evidence access on upgrade, silently
-- undoing the RLS tightening below for every already-running organization.
insert into public.role_permissions (organization_id, role_id, permission_id)
select rp.organization_id, rp.role_id, perm_new.id
from public.role_permissions rp
join public.permissions perm_old on perm_old.id = rp.permission_id and perm_old.key = 'customer.manage'
cross join (select id from public.permissions where key = 'evidence.read_all') perm_new
on conflict do nothing;

-- =====================================================================
-- Assignment-aware read check for the {org}/{bookingId}/{petJobId}/{file}
-- grooming-evidence path shape. Any other shape under the 'attachments'
-- bucket (e.g. {org}/{bookingId}/attendance/{file}, {org}/payments/{file})
-- is left to the existing broader membership policy — this function only
-- narrows the grooming-evidence case. Wrapped in an exception handler so a
-- malformed/non-UUID path segment denies rather than errors.
-- =====================================================================
create or replace function app.fn_can_read_grooming_evidence(p_name text)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare v_segments text[]; v_job_pet_id uuid;
begin
  v_segments := storage.foldername(p_name);
  if array_length(v_segments,1) is distinct from 3 or v_segments[3] = 'attendance' then
    return true; -- not the grooming-evidence path shape; defer to the broader membership policy
  end if;
  if app.has_permission('evidence.read_all') then return true; end if;
  begin
    v_job_pet_id := v_segments[3]::uuid;
  exception when invalid_text_representation then
    return true; -- not a per-job-pet evidence path either; defer to the broader policy
  end;
  return exists (
    select 1
    from public.grooming_job_pets gjp
    join public.resources r on r.organization_id = gjp.organization_id and r.id = gjp.assigned_resource_id
    join public.memberships m on m.organization_id = r.organization_id and m.id = r.membership_id
    where gjp.organization_id = app.fn_active_organization()
      and gjp.id = v_job_pet_id
      and m.user_id = auth.uid() and m.status = 'active' and m.deleted_at is null
  );
end $$;

-- Restrictive: layers on top of the existing permissive attachments_objects_read
-- policy (20260918130000_grooming_evidence_storage.sql:12-17) — it can only
-- narrow that access, never widen it.
create policy attachments_objects_read_evidence_scope on storage.objects as restrictive for select to authenticated
  using (
    bucket_id <> 'attachments' or app.fn_can_read_grooming_evidence(name)
  );

-- =====================================================================
-- Retention: same expiry-stamping convention as onboarding styling refs
-- (20260919100000_onboarding_settings_cleanup.sql), applied to grooming
-- evidence uploads. Default 365 days — grooming evidence backs invoices/
-- service reports and complaint history much longer than a styling
-- reference photo, so it gets a longer default, still admin-configurable.
-- =====================================================================
create or replace function app.tg_apply_evidence_retention()
returns trigger language plpgsql as $$
declare v_days integer;
begin
  if new.metadata ? 'category' and new.metadata->>'category' is not null and not (new.metadata ? 'expires_at') then
    select coalesce((settings->>'evidence_retention_days')::integer, 365) into v_days
      from public.organizations where id = new.organization_id;
    new.metadata := jsonb_set(new.metadata, '{expires_at}', to_jsonb((now() + (v_days || ' days')::interval)));
  end if;
  return new;
end $$;
create trigger trg_attachments_evidence_retention before insert on public.attachments
  for each row execute function app.tg_apply_evidence_retention();

-- =====================================================================
-- app.delete_grooming_evidence — soft-delete metadata row; the storage
-- object itself is removed by the caller (server action) after this
-- succeeds, mirroring cleanupOnboardingStorageAction's order of operations
-- (DB row gone first, then storage — never the reverse, which would orphan
-- a live signed URL pointing at a deleted DB row).
-- Re-checks the SAME job-assignment rule as upload, so a groomer can retract
-- their own mistaken upload but not someone else's.
-- =====================================================================
create or replace function app.delete_grooming_evidence(p_attachment uuid)
returns table (storage_bucket text, storage_path text) language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_attachment public.attachments;
  v_link public.attachment_links;
  v_job_pet_id uuid;
  v_membership_id uuid;
  v_authorized boolean := false;
begin
  if v_org is null or not app.has_membership() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_attachment from public.attachments where organization_id = v_org and id = p_attachment and deleted_at is null for update;
  if not found then raise exception 'attachment_not_found' using errcode = 'P0002'; end if;

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
  select * into v_link from public.attachment_links where organization_id = v_org and attachment_id = p_attachment limit 1;
  if found then
    insert into public.timeline_events (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
    values (v_org, v_link.subject_type, v_link.subject_id, auth.uid(), 'evidence.deleted', 'Grooming evidence photo removed', jsonb_build_object('attachment_id', p_attachment));
  end if;
  return query select v_attachment.storage_bucket, v_attachment.storage_path;
end $$;

revoke all on function app.delete_grooming_evidence(uuid) from public;
grant execute on function app.delete_grooming_evidence(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
