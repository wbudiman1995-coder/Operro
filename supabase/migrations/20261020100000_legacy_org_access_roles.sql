-- Existing organizations predate the platform invitation roles. Preserve their
-- current memberships and grants while adding the roles needed for new invites.
begin;

insert into public.roles(organization_id,name,description,is_system)
select o.id, v.name, v.description, true
from public.organizations o
cross join (values
  ('Pemilik','Pemilik bisnis; mengelola akses dan payroll'),
  ('Admin','Izin operasional dipilih pemilik bisnis'),
  ('Bantuan Operro','Bantuan operasional tanpa akses payroll'),
  ('Groomer','Jadwal pribadi dan bukti grooming')
) v(name,description)
where o.deleted_at is null
on conflict (organization_id,name) do nothing;

-- Only newly empty role grant sets receive defaults. Never overwrite a
-- business's existing Admin checklist or an older Owner role.
insert into public.role_permissions(organization_id,role_id,permission_id)
select r.organization_id,r.id,p.id
from public.roles r join public.permissions p on p.deleted_at is null
where r.deleted_at is null and r.name='Pemilik'
  and not exists(select 1 from public.role_permissions rp where rp.role_id=r.id)
on conflict do nothing;

insert into public.role_permissions(organization_id,role_id,permission_id)
select r.organization_id,r.id,p.id
from public.roles r join public.permissions p on p.deleted_at is null
where r.deleted_at is null and r.name='Admin'
  and p.key in ('booking.read','booking.create','booking.update','booking.cancel',
    'customer.read','customer.manage','resource.manage','service.manage',
    'membership.read','membership.manage','invoice.issue','finance.read',
    'payment.manage','task.manage','reports.view','branches.all','settings.manage')
  and not exists(select 1 from public.role_permissions rp where rp.role_id=r.id)
on conflict do nothing;

insert into public.role_permissions(organization_id,role_id,permission_id)
select r.organization_id,r.id,p.id
from public.roles r join public.permissions p on p.deleted_at is null
where r.deleted_at is null and r.name='Bantuan Operro'
  and p.key not like 'payroll.%'
  and p.key not in ('roles.manage','users.manage','finance.read','reports.view')
  and not exists(select 1 from public.role_permissions rp where rp.role_id=r.id)
on conflict do nothing;

insert into public.role_permissions(organization_id,role_id,permission_id)
select r.organization_id,r.id,p.id
from public.roles r join public.permissions p on p.deleted_at is null
where r.deleted_at is null and r.name='Groomer'
  and p.key in ('booking.read','booking.update')
  and not exists(select 1 from public.role_permissions rp where rp.role_id=r.id)
on conflict do nothing;

-- Legacy HomePaw owners have role names Owner/Pemilik Demo. They remain valid
-- business owners without rewriting historical memberships or grants.
create or replace function app.is_business_owner(p_org uuid) returns boolean
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

-- Only an actual business owner can set that business's Admin checklist.
-- The Operro platform owner may provision/invite/bill, but cannot do this.
create function app.is_business_owner_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not app.is_operro_owner() and exists (
    select 1 from public.memberships m
    join public.roles r on r.id=m.role_id and r.organization_id=m.organization_id
    join public.organizations o on o.id=m.organization_id
    where m.user_id=auth.uid() and m.organization_id=p_org
      and m.status='active' and m.deleted_at is null
      and r.name in ('Pemilik','Owner','Pemilik Demo') and r.deleted_at is null
      and o.status in ('trial','active') and o.deleted_at is null
  );
$$;
revoke all on function app.is_business_owner_member(uuid) from public;
grant execute on function app.is_business_owner_member(uuid) to authenticated;

-- Platform support may manage accounts, but the business's Admin checklist is
-- private to its owner even when the platform account also holds a legacy
-- Owner membership. Keep the member list available to platform support.
create or replace function app.list_organization_access(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_business_owner(p_org) then raise exception 'not_authorized' using errcode='42501'; end if;
  return jsonb_build_object(
    'members',coalesce((select jsonb_agg(jsonb_build_object('email',u.email,'role',r.name,'status',m.status) order by u.email)
      from public.memberships m join public.users u on u.id=m.user_id join public.roles r on r.id=m.role_id
      where m.organization_id=p_org and m.deleted_at is null), '[]'::jsonb),
    'admin_keys',case when app.is_business_owner_member(p_org) then coalesce((select jsonb_agg(p.key order by p.key)
      from public.role_permissions rp join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
      where r.organization_id=p_org and r.name='Admin'),'[]'::jsonb) else '[]'::jsonb end,
    'options',case when app.is_business_owner_member(p_org) then coalesce((select jsonb_agg(jsonb_build_object('key',p.key,'description',p.description) order by p.key)
      from public.permissions p where p.deleted_at is null and p.key not in ('roles.manage','users.manage')),'[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- Preserve the protection for old Owner/Pemilik Demo memberships until a
-- platform owner explicitly migrates that member to the new Pemilik role.
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
  if not app.is_operro_owner() and v_old_role in ('Pemilik','Owner','Pemilik Demo','Bantuan Operro') then
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

create or replace function app.set_business_admin_permissions(p_org uuid,p_keys text[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_role uuid;
begin
  if not app.is_business_owner_member(p_org) then raise exception 'not_business_owner' using errcode='42501'; end if;
  if cardinality(p_keys)>80 or exists(
    select 1 from unnest(p_keys) k where k in ('roles.manage','users.manage')
      or not exists(select 1 from public.permissions p where p.key=k and p.deleted_at is null)
  ) then raise exception 'invalid_permissions' using errcode='22023'; end if;
  select id into v_role from public.roles where organization_id=p_org and name='Admin' and deleted_at is null for update;
  if v_role is null then raise exception 'admin_role_not_found' using errcode='22023'; end if;
  delete from public.role_permissions where organization_id=p_org and role_id=v_role;
  insert into public.role_permissions(organization_id,role_id,permission_id)
  select p_org,v_role,p.id from public.permissions p where p.key=any(p_keys) and p.deleted_at is null;
end;
$$;

commit;
