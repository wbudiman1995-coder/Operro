-- Stream 6: record-backed access readiness for the platform owner (parity #41).
--
-- A read-only summary of the state that decides whether an invited business can actually get in, so the owner can see what to chase
-- before a hosted QC run or a support call. It reads only existing records (organizations, memberships, roles, invitations) and
-- returns COUNTS and fixed flag codes. It never returns an e-mail address, a token, a token hash or a user id, never creates or sends an
-- invitation, and never changes anything.
--
-- Per organization (not deleted):
--   active_members / suspended_members / active_owners   memberships by status; an owner is a role named Pemilik, Owner or Pemilik Demo
--   pending_invitations (still valid) / expired_pending_invitations / accepted_invitations / revoked_invitations
--   flags (what needs attention):
--     suspended_workspace          the workspace is suspended, so no one can claim an invitation or sign in to it
--     no_active_owner              a trial or active workspace without an active business owner
--     owner_invitation_pending     ... and a valid owner invitation is waiting to be claimed (nothing to do but wait or resend)
--     owner_invitation_expired     ... and the newest owner invitation expired unclaimed (issue a new one)
--     no_owner_invitation          ... and no owner invitation exists at all
--     expired_pending_invitations  invitations that expired without being claimed or revoked
-- Totals add the number of people who are active in more than one organization (the multi-organization switching cases to QC).
--
-- Authority: the Operro platform owner only (app.is_operro_owner). Everyone else, including a business owner, is refused.
begin;

create function app.access_readiness_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c_owner_roles constant text[] := array['Pemilik','Owner','Pemilik Demo'];
  v_rows jsonb;
  v_total integer;
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;

  select count(*) into v_total from public.organizations o where o.deleted_at is null;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.name, x.organization_id), '[]'::jsonb) into v_rows
  from (
    select o.id as organization_id, o.name, o.slug, o.status,
           m.active_members, m.suspended_members, m.active_owners,
           i.pending_invitations, i.expired_pending_invitations, i.accepted_invitations, i.revoked_invitations,
           array_remove(array[
             case when o.status = 'suspended' then 'suspended_workspace' end,
             case when o.status in ('trial','active') and m.active_owners = 0 then 'no_active_owner' end,
             case when o.status in ('trial','active') and m.active_owners = 0 and i.pending_owner_invitations > 0 then 'owner_invitation_pending' end,
             case when o.status in ('trial','active') and m.active_owners = 0 and i.pending_owner_invitations = 0 and i.expired_owner_invitations > 0 then 'owner_invitation_expired' end,
             case when o.status in ('trial','active') and m.active_owners = 0 and i.pending_owner_invitations = 0 and i.expired_owner_invitations = 0 then 'no_owner_invitation' end,
             case when i.expired_pending_invitations > 0 then 'expired_pending_invitations' end
           ], null) as flags
      from public.organizations o
      cross join lateral (
        select count(*) filter (where ms.status = 'active' and ms.deleted_at is null)::integer as active_members,
               count(*) filter (where ms.status <> 'active' and ms.deleted_at is null)::integer as suspended_members,
               count(*) filter (where ms.status = 'active' and ms.deleted_at is null and r.name = any (c_owner_roles))::integer as active_owners
          from public.memberships ms
          left join public.roles r on r.id = ms.role_id and r.organization_id = ms.organization_id and r.deleted_at is null
         where ms.organization_id = o.id) m
      cross join lateral (
        select count(*) filter (where v.status = 'pending' and v.expires_at > now())::integer as pending_invitations,
               count(*) filter (where v.status = 'pending' and v.expires_at <= now())::integer as expired_pending_invitations,
               count(*) filter (where v.status = 'accepted')::integer as accepted_invitations,
               count(*) filter (where v.status = 'revoked')::integer as revoked_invitations,
               count(*) filter (where v.status = 'pending' and v.expires_at > now() and v.role_name = 'Pemilik')::integer as pending_owner_invitations,
               count(*) filter (where v.status = 'pending' and v.expires_at <= now() and v.role_name = 'Pemilik')::integer as expired_owner_invitations
          from public.platform_access_invitations v where v.organization_id = o.id) i
     where o.deleted_at is null
     order by o.name, o.id
     limit 200
  ) x;

  return jsonb_build_object(
    'generated_at', now(),
    'organizations', v_rows,
    'truncated', v_total > 200,
    'totals', jsonb_build_object(
      'organizations', v_total,
      'suspended_workspaces', (select count(*) from public.organizations o where o.deleted_at is null and o.status = 'suspended'),
      'without_active_owner', (select count(*) from public.organizations o where o.deleted_at is null and o.status in ('trial','active')
                                and not exists (select 1 from public.memberships ms join public.roles r on r.id = ms.role_id and r.organization_id = ms.organization_id and r.deleted_at is null
                                                 where ms.organization_id = o.id and ms.status = 'active' and ms.deleted_at is null and r.name = any (c_owner_roles))),
      'pending_invitations', (select count(*) from public.platform_access_invitations v where v.status = 'pending' and v.expires_at > now()),
      'expired_pending_invitations', (select count(*) from public.platform_access_invitations v where v.status = 'pending' and v.expires_at <= now()),
      'people_in_several_organizations', (select count(*) from (
          select ms.user_id from public.memberships ms where ms.status = 'active' and ms.deleted_at is null group by ms.user_id having count(distinct ms.organization_id) > 1) s)));
end $$;

revoke all on function app.access_readiness_summary() from public, anon, authenticated;
grant execute on function app.access_readiness_summary() to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101150000'::text;
$$;

notify pgrst, 'reload schema';
commit;
