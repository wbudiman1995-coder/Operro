-- Batches the per-key app.has_permission(text) round trips used by
-- loadCapabilities into one call. Every authenticated route previously made
-- 13 sequential RPC calls (one per CapabilityKey) to answer "what can this
-- user do here" — this returns the same answer, computed with the identical
-- join/filter conditions as app.has_permission (frozen in migration
-- 20260721001400 and NOT altered here), in a single round trip.
--
-- Contract: returns one row per permission key the caller currently holds in
-- their active organization. A key's absence from the result means denied —
-- callers must default to false for any key not returned, exactly as
-- loadCapabilities already treats a failed/erroring has_permission call.
create or replace function app.list_my_permissions()
returns table (perm text)
language plpgsql
stable
security definer
set search_path = app, public
as $$
begin
  if app.is_platform_admin() then
    return query select p.key from public.permissions p;
    return;
  end if;

  return query
    select distinct p.key
    from public.users u
    join public.memberships m on m.user_id = u.id
    join public.organizations o on o.id = m.organization_id
    join public.role_permissions rp
      on rp.organization_id = m.organization_id and rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id
    where u.id = app.fn_current_user_id()
      and u.status = 'active'
      and u.deleted_at is null
      and m.organization_id = app.fn_active_organization()
      and m.status = 'active'
      and m.deleted_at is null
      and o.status in ('trial', 'active')
      and o.deleted_at is null;
end;
$$;
revoke all on function app.list_my_permissions() from public;
grant execute on function app.list_my_permissions() to authenticated;
