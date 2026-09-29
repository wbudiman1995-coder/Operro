-- One-time repair for the original HomePaw organization, which was created
-- without role grants, an active subscription, enabled modules, or a branch.
-- Scope is deliberately pinned to the known organization/role/user tuple;
-- a role merely named Owner in another tenant must never gain privileges.
begin;

do $$
declare
  v_org constant uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
  v_role constant uuid := '019fbdd0-ee64-7327-97e4-fe23f30dbff1';
  v_user constant uuid := '047f1e5c-5935-4566-b793-417df9f7cc9c';
begin
  -- Fresh/local databases do not contain this legacy organization.
  if not exists (select 1 from public.organizations where id = v_org) then
    return;
  end if;

  if not exists (
    select 1 from public.organizations o
    join public.roles r on r.organization_id = o.id
    join public.memberships m on m.organization_id = o.id and m.role_id = r.id
    where o.id = v_org and o.name = 'HomePaw' and o.status = 'active' and o.deleted_at is null
      and r.id = v_role and r.name = 'Owner' and r.is_system and r.deleted_at is null
      and m.user_id = v_user and m.status = 'active' and m.deleted_at is null
  ) then
    raise exception 'homepaw_owner_workspace_identity_mismatch';
  end if;

  -- Stop if this org has since been independently provisioned. This migration
  -- must not overwrite a deliberate permission or commercial configuration.
  if exists (select 1 from public.role_permissions where organization_id = v_org)
    or exists (select 1 from public.subscriptions where organization_id = v_org and deleted_at is null)
    or exists (select 1 from public.organization_modules where organization_id = v_org)
    or exists (select 1 from public.branches where organization_id = v_org and deleted_at is null)
  then
    raise exception 'homepaw_owner_workspace_already_provisioned';
  end if;

  insert into public.role_permissions (organization_id, role_id, permission_id)
  select v_org, v_role, p.id from public.permissions p where p.deleted_at is null;

  -- Custom pilot entitlement, matching the existing HomePaw Demo model.
  -- Commercial plan enrollment for future paying tenants is separate work.
  insert into public.subscriptions (organization_id, status, current_period_start)
  values (v_org, 'active', now());

  insert into public.organization_modules (organization_id, module_id, enabled, source)
  select v_org, m.id, true, 'override'
  from public.modules m where m.is_active and m.deleted_at is null;

  insert into public.branches (organization_id, name, status, timezone, is_default)
  values (v_org, 'HomePaw Dispatch', 'active', 'Asia/Jakarta', true);
end;
$$;

notify pgrst, 'reload schema';
commit;
