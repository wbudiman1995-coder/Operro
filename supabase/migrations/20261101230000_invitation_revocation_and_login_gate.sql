-- Keep invitation history for auditability while making an unused bearer link
-- immediately unusable. Business owners may revoke only Admin invitations;
-- platform-only roles remain under the Operro owner.
create or replace function app.revoke_access_invitation(p_org uuid, p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.platform_access_invitations;
begin
  select * into v_invitation
  from public.platform_access_invitations
  where id = p_invitation and organization_id = p_org
  for update;

  if not found then
    raise exception 'invitation_not_found' using errcode = '22023';
  end if;

  if not app.is_operro_owner()
    and not (v_invitation.role_name = 'Admin' and app.is_business_owner(p_org))
  then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'invitation_not_pending' using errcode = '22023';
  end if;

  update public.platform_access_invitations
  set status = 'revoked'
  where id = v_invitation.id;
end;
$$;

revoke all on function app.revoke_access_invitation(uuid, uuid) from public;
grant execute on function app.revoke_access_invitation(uuid, uuid) to authenticated;

-- Normal sign-in is only useful for an active Operro account. New invitees
-- create or enter their account through /accept first, where the claim RPC also
-- requires the verified Auth email to exactly match the invitation email.
create or replace function app.can_access_operro()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.status = 'active'
      and u.deleted_at is null
      and (
        app.is_operro_owner()
        or exists (
          select 1
          from public.memberships m
          join public.organizations o on o.id = m.organization_id
          where m.user_id = u.id
            and m.status = 'active'
            and m.deleted_at is null
            and o.status in ('trial', 'active')
            and o.deleted_at is null
        )
      )
  );
$$;

revoke all on function app.can_access_operro() from public;
grant execute on function app.can_access_operro() to authenticated;

-- Return the stable invitation id so an authorized owner can revoke one exact
-- pending row without accepting a client-supplied email or role as authority.
create or replace function app.list_access_invitations(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',i.id,
      'email',i.email,
      'role',i.role_name,
      'status',i.status,
      'expired',i.status = 'pending' and i.expires_at <= now(),
      'created_at',i.created_at,
      'expires_at',i.expires_at
    ) order by i.created_at desc)
    from (select * from public.platform_access_invitations where organization_id=p_org order by created_at desc limit 30) i),'[]'::jsonb);
end;
$$;

revoke all on function app.list_access_invitations(uuid) from public;
grant execute on function app.list_access_invitations(uuid) to authenticated;

notify pgrst, 'reload schema';

create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101230000'::text;
$$;
