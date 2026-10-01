-- The Operro owner must be able to inspect and repair every workspace, while
-- ordinary business owners still require their own active membership.
begin;

-- Workspace switching uses a real membership, even for the platform owner.
-- Preserve any existing membership/role in legacy organizations.
insert into public.memberships(user_id, organization_id, role_id, status)
select u.id, r.organization_id, r.id, 'active'
from public.users u
join public.roles r on r.name = 'Bantuan Operro' and r.deleted_at is null
join public.organizations o on o.id = r.organization_id and o.deleted_at is null
where lower(u.email) = 'wbudiman1995@gmail.com' and u.is_platform_admin
  and u.status = 'active' and u.deleted_at is null
on conflict (user_id, organization_id) do nothing;

create function app.attach_operro_owner_to_new_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.name = 'Bantuan Operro' and new.deleted_at is null then
    insert into public.memberships(user_id, organization_id, role_id, status)
    select u.id, new.organization_id, new.id, 'active'
    from public.users u
    where lower(u.email) = 'wbudiman1995@gmail.com' and u.is_platform_admin
      and u.status = 'active' and u.deleted_at is null
    on conflict (user_id, organization_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function app.attach_operro_owner_to_new_workspace() from public;
create trigger trg_attach_operro_owner_to_new_workspace
after insert on public.roles for each row execute function app.attach_operro_owner_to_new_workspace();

-- Platform owner may inspect the Admin checklist too. The application still
-- checks app.is_business_owner_member before showing or changing it.
create or replace function app.is_business_owner_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_operro_owner() or exists (
    select 1 from public.memberships m
    join public.roles r on r.id=m.role_id and r.organization_id=m.organization_id
    join public.organizations o on o.id=m.organization_id
    where m.user_id=auth.uid() and m.organization_id=p_org
      and m.status='active' and m.deleted_at is null
      and r.name in ('Pemilik','Owner','Pemilik Demo') and r.deleted_at is null
      and o.status in ('trial','active') and o.deleted_at is null
  );
$$;

-- A business owner must never be able to suspend or downgrade the platform
-- owner's legacy Admin membership. Other member edits retain existing rules.
create or replace function app.set_organization_member_role(p_org uuid,p_email text,p_role text,p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_role uuid; v_member public.memberships; v_owner_count integer; v_old_role text;
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_role not in ('Pemilik','Admin','Bantuan Operro','Groomer') or p_status not in ('active','suspended')
    or (p_role in ('Pemilik','Bantuan Operro') and not app.is_operro_owner())
  then raise exception 'invalid_role' using errcode='22023'; end if;
  select id into v_user from public.users where lower(email)=lower(btrim(p_email)) and deleted_at is null;
  select id into v_role from public.roles where organization_id=p_org and name=p_role and deleted_at is null;
  select * into v_member from public.memberships where organization_id=p_org and user_id=v_user and deleted_at is null for update;
  if v_user is null or v_role is null or v_member.id is null then raise exception 'member_not_found' using errcode='22023'; end if;
  select name into v_old_role from public.roles where id=v_member.role_id;
  if not app.is_operro_owner() and
    (v_old_role in ('Pemilik','Owner','Pemilik Demo','Bantuan Operro')
      or exists(select 1 from public.users u where u.id=v_user and u.is_platform_admin)) then
    raise exception 'protected_member' using errcode='42501';
  end if;
  if v_old_role in ('Pemilik','Owner','Pemilik Demo') and (p_role<>'Pemilik' or p_status<>'active') then
    select count(*) into v_owner_count from public.memberships m join public.roles r on r.id=m.role_id
    where m.organization_id=p_org and m.status='active' and m.deleted_at is null
      and r.name in ('Pemilik','Owner','Pemilik Demo');
    if v_owner_count<=1 then raise exception 'last_owner' using errcode='22023'; end if;
  end if;
  update public.memberships set role_id=v_role,status=p_status where id=v_member.id;
  update public.platform_access_invitations set status='revoked'
    where organization_id=p_org and email=lower(btrim(p_email)) and status='pending';
end;
$$;

-- A suspended business stays blocked for its own staff, but Operro can open
-- it to investigate billing and repair data without first reactivating it.
create or replace function app.tg_validate_active_organization() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
begin
  if new.active_organization_id is null then return new; end if;
  if not exists (
    select 1 from public.memberships m join public.organizations o on o.id=m.organization_id
    where m.user_id=new.id and m.organization_id=new.active_organization_id
      and m.status='active' and m.deleted_at is null and o.deleted_at is null
      and (o.status in ('trial','active') or
        (o.status='suspended' and new.is_platform_admin and lower(new.email)='wbudiman1995@gmail.com'))
  ) then raise exception 'active_organization_not_available' using errcode='42501'; end if;
  return new;
end;
$$;

create or replace function public.set_active_organization(p_organization_id uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare v_user_id uuid;
begin
  v_user_id := app.fn_current_user_id();
  if v_user_id is null then raise exception 'authentication_required' using errcode='28000'; end if;
  if p_organization_id is null then raise exception 'organization_id_required' using errcode='22004'; end if;
  if not exists(select 1 from public.users u where u.id=v_user_id and u.status='active' and u.deleted_at is null)
  then raise exception 'active_user_profile_not_found' using errcode='P0002'; end if;
  if not exists (
    select 1 from public.memberships m join public.organizations o on o.id=m.organization_id
    where m.user_id=v_user_id and m.organization_id=p_organization_id
      and m.status='active' and m.deleted_at is null and o.deleted_at is null
      and (o.status in ('trial','active') or (o.status='suspended' and app.is_operro_owner()))
  ) then raise exception 'organization_membership_not_available' using errcode='42501'; end if;
  update public.users set active_organization_id=p_organization_id
    where id=v_user_id and status='active' and deleted_at is null;
  if not found then raise exception 'active_user_profile_not_found' using errcode='P0002'; end if;
  return p_organization_id;
end;
$$;

-- Keep the custom token hook's existing Supabase claim preservation and
-- platform flag behavior; only permit the platform owner's suspended selection.
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security invoker set search_path = pg_catalog as $$
declare
  v_user_id uuid; v_profile_is_active boolean := false; v_is_platform_admin boolean := false;
  v_preferred_organization_id uuid; v_active_organization_id uuid;
  v_claims jsonb; v_app_metadata jsonb;
begin
  if event is null or jsonb_typeof(event)<>'object' or nullif(event->>'user_id','') is null
  then raise exception 'invalid_custom_access_token_event' using errcode='22023'; end if;
  begin v_user_id := (event->>'user_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'invalid_custom_access_token_user_id' using errcode='22023';
  end;
  if event->'claims' is null or jsonb_typeof(event->'claims')<>'object'
  then raise exception 'invalid_custom_access_token_claims' using errcode='22023'; end if;
  v_claims := event->'claims';
  select true,u.is_platform_admin,u.active_organization_id
    into v_profile_is_active,v_is_platform_admin,v_preferred_organization_id
  from public.users u where u.id=v_user_id and u.status='active' and u.deleted_at is null;
  v_profile_is_active := coalesce(v_profile_is_active,false);
  v_is_platform_admin := coalesce(v_is_platform_admin,false);
  v_claims := v_claims - 'active_org_id';
  if v_profile_is_active then
    select m.organization_id into v_active_organization_id
    from public.memberships m join public.organizations o on o.id=m.organization_id
    where m.user_id=v_user_id and m.status='active' and m.deleted_at is null
      and o.deleted_at is null
      and (o.status in ('trial','active') or
        (o.status='suspended' and v_is_platform_admin and exists(
          select 1 from public.users u where u.id=v_user_id and lower(u.email)='wbudiman1995@gmail.com')))
    order by case when m.organization_id=v_preferred_organization_id then 0 else 1 end,m.created_at,m.id limit 1;
  end if;
  if v_active_organization_id is not null then
    v_claims := jsonb_set(v_claims,'{active_org_id}',to_jsonb(v_active_organization_id::text),true);
  end if;
  if jsonb_typeof(v_claims->'app_metadata')='object' then v_app_metadata := v_claims->'app_metadata';
  else v_app_metadata := '{}'::jsonb; end if;
  v_app_metadata := jsonb_set(v_app_metadata,'{is_platform_admin}',to_jsonb(v_is_platform_admin),true);
  v_claims := jsonb_set(v_claims,'{app_metadata}',v_app_metadata,true);
  return jsonb_set(event,'{claims}',v_claims,true);
end;
$$;

commit;
