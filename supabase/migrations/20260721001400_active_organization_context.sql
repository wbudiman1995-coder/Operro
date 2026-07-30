-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0014_active_organization_context
-- Milestone        11 — Web / Authentication
-- Purpose          Synchronize Supabase Auth identities into public.users,
--                  persist and validate the selected organization, expose a
--                  controlled organization-switch RPC, and mint authoritative
--                  active_org_id plus app_metadata.is_platform_admin claims.
-- Dependencies     20260721000100 through 20260721001350 (frozen).
-- Objects Created  COLUMN public.users.active_organization_id
--                  FUNCTION app.tg_sync_auth_user()
--                  TRIGGER  auth.users.trg_auth_users_sync
--                  FUNCTION app.tg_validate_active_organization()
--                  TRIGGER  public.users.trg_users_validate_active_organization
--                  FUNCTION public.set_active_organization(uuid)
--                  FUNCTION public.custom_access_token_hook(jsonb)
--                  RLS policies for supabase_auth_admin hook reads
-- Objects Modified public.users privileges; identity-policy role scopes;
--                  app.has_membership(), app.has_permission(text), and
--                  app.has_branch(uuid) live-state checks.
-- Security         The Auth hook is SECURITY INVOKER and receives only the
--                  column SELECT privileges it requires. Organization switching
--                  is SECURITY DEFINER, binds the target row to the signed JWT
--                  subject, validates live membership and organization state,
--                  and has a fixed pg_catalog-only search_path.
-- Breaking Changes Authenticated users may directly update only full_name on
--                  public.users. active_organization_id must be changed through
--                  public.set_active_organization(uuid).
-- Rollback         See SECTION 099. Disable the dashboard Auth Hook before
--                  executing any manual rollback.
-- Tests            See SECTION 098. Tests are intentionally not executed inside
--                  this migration; they must run as separate non-superuser SQL.
-- =====================================================================

begin;

-- =====================================================================
-- SECTION 000 — Dependency and lineage assertions
-- =====================================================================

do $$
begin
  if to_regclass('public.users') is null
     or to_regclass('public.organizations') is null
     or to_regclass('public.memberships') is null then
    raise exception
      using
        errcode = '42P01',
        message = 'Migration 01400 requires public.users, public.organizations, and public.memberships.';
  end if;

  if to_regprocedure('app.fn_current_user_id()') is null
     or to_regprocedure('app.fn_active_organization()') is null
     or to_regprocedure('app.is_platform_admin()') is null then
    raise exception
      using
        errcode = '42883',
        message = 'Migration 01400 requires the frozen JWT helper functions.';
  end if;
end;
$$;


-- =====================================================================
-- SECTION 001 — Persisted active organization
-- =====================================================================

alter table public.users
  add column active_organization_id uuid;

alter table public.users
  add constraint fk_users_active_organization
  foreign key (active_organization_id)
  references public.organizations (id)
  on delete set null;

create index idx_users_active_organization
  on public.users (active_organization_id)
  where active_organization_id is not null;

comment on column public.users.active_organization_id is
  'Last organization selected by the user. It is changed only through '
  'public.set_active_organization(uuid). The access-token hook revalidates '
  'the selection before minting active_org_id.';


-- =====================================================================
-- SECTION 002 — Validate every persisted active-organization write
-- =====================================================================

create or replace function app.tg_validate_active_organization()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.active_organization_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.memberships as m
    join public.organizations as o
      on o.id = m.organization_id
    where m.user_id = new.id
      and m.organization_id = new.active_organization_id
      and m.status = 'active'
      and m.deleted_at is null
      and o.status in ('trial', 'active')
      and o.deleted_at is null
  ) then
    raise exception
      using
        errcode = '42501',
        message = 'active_organization_not_available',
        detail = 'The selected organization requires a live active membership and an operational organization.';
  end if;

  return new;
end;
$$;

comment on function app.tg_validate_active_organization() is
  'Defense-in-depth trigger that rejects persisted organization selections '
  'without a live active membership in an operational organization.';

revoke execute
  on function app.tg_validate_active_organization()
  from anon, authenticated, service_role, public;

create trigger trg_users_validate_active_organization
before insert or update of active_organization_id
on public.users
for each row
execute function app.tg_validate_active_organization();


-- =====================================================================
-- SECTION 003 — Supabase Auth user synchronization
-- =====================================================================

create or replace function app.tg_sync_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_email text;
  v_full_name text;
begin
  v_email := coalesce(
    nullif(new.email, ''),
    new.id::text || '@users.invalid'
  );

  v_full_name := nullif(
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    ''
  );

  begin
    insert into public.users (
      id,
      email,
      full_name,
      status
    )
    values (
      new.id,
      v_email,
      v_full_name,
      'active'
    )
    on conflict (id) do update
    set
      email = excluded.email,
      -- public.users is the application profile source of truth. Auth
      -- metadata may fill an empty name but must not overwrite an existing
      -- application-managed value.
      full_name = coalesce(public.users.full_name, excluded.full_name)
    where public.users.email is distinct from excluded.email
       or (
         public.users.full_name is null
         and excluded.full_name is not null
       );
  exception
    when unique_violation then
      raise exception
        using
          errcode = '23505',
          message = 'auth_user_profile_email_conflict',
          detail = 'The Auth identity email conflicts with another public.users profile.';
  end;

  return new;
end;
$$;

comment on function app.tg_sync_auth_user() is
  'Synchronizes auth.users id/email and initial display name into public.users. '
  'Runs as the migration owner because Auth callers do not write public.users directly.';

revoke execute
  on function app.tg_sync_auth_user()
  from anon, authenticated, service_role, public;

create trigger trg_auth_users_sync
after insert or update of email, raw_user_meta_data
on auth.users
for each row
execute function app.tg_sync_auth_user();

-- Fail with a controlled diagnostic before the set-based backfill if the
-- desired Auth email mapping would violate public.users' case-insensitive
-- unique index. Never merge identities by email or silently reassign rows.
do $$
declare
  v_detail text;
begin
  select string_agg(d.id::text, ', ' order by d.id)
  into v_detail
  from (
    select
      au.id,
      lower(
        coalesce(
          nullif(au.email, ''),
          au.id::text || '@users.invalid'
        )
      ) as normalized_email
    from auth.users as au
  ) as d
  join (
    select
      lower(
        coalesce(
          nullif(au.email, ''),
          au.id::text || '@users.invalid'
        )
      ) as normalized_email
    from auth.users as au
    group by 1
    having count(*) > 1
  ) as duplicates
    on duplicates.normalized_email = d.normalized_email;

  if v_detail is not null then
    raise exception
      using
        errcode = '23505',
        message = 'duplicate_auth_identity_email',
        detail = 'Conflicting auth.users ids: ' || v_detail;
  end if;

  select format(
    'public.users id %s conflicts with auth.users id %s',
    pu.id,
    au.id
  )
  into v_detail
  from auth.users as au
  join public.users as pu
    on lower(pu.email) = lower(
      coalesce(
        nullif(au.email, ''),
        au.id::text || '@users.invalid'
      )
    )
   and pu.id <> au.id
  order by pu.id, au.id
  limit 1;

  if v_detail is not null then
    raise exception
      using
        errcode = '23505',
        message = 'public_user_email_identity_mismatch',
        detail = v_detail;
  end if;
end;
$$;

-- Backfill Auth identities created before this migration. Existing profile
-- names are preserved; missing names may be initialized from Auth metadata.
insert into public.users (
  id,
  email,
  full_name,
  status
)
select
  au.id,
  coalesce(
    nullif(au.email, ''),
    au.id::text || '@users.invalid'
  ),
  nullif(
    coalesce(
      au.raw_user_meta_data ->> 'full_name',
      au.raw_user_meta_data ->> 'name'
    ),
    ''
  ),
  'active'
from auth.users as au
on conflict (id) do update
set
  email = excluded.email,
  full_name = coalesce(public.users.full_name, excluded.full_name)
where public.users.email is distinct from excluded.email
   or (
     public.users.full_name is null
     and excluded.full_name is not null
   );


-- =====================================================================
-- SECTION 004 — Controlled active-organization switch RPC
-- =====================================================================

create or replace function public.set_active_organization(
  p_organization_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid;
begin
  v_user_id := app.fn_current_user_id();

  if v_user_id is null then
    raise exception
      using
        errcode = '28000',
        message = 'authentication_required';
  end if;

  if p_organization_id is null then
    raise exception
      using
        errcode = '22004',
        message = 'organization_id_required';
  end if;

  if not exists (
    select 1
    from public.users as u
    where u.id = v_user_id
      and u.status = 'active'
      and u.deleted_at is null
  ) then
    raise exception
      using
        errcode = 'P0002',
        message = 'active_user_profile_not_found';
  end if;

  if not exists (
    select 1
    from public.memberships as m
    join public.organizations as o
      on o.id = m.organization_id
    where m.user_id = v_user_id
      and m.organization_id = p_organization_id
      and m.status = 'active'
      and m.deleted_at is null
      and o.status in ('trial', 'active')
      and o.deleted_at is null
  ) then
    raise exception
      using
        errcode = '42501',
        message = 'organization_membership_not_available';
  end if;

  update public.users
  set active_organization_id = p_organization_id
  where id = v_user_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception
      using
        errcode = 'P0002',
        message = 'active_user_profile_not_found';
  end if;

  return p_organization_id;
end;
$$;

comment on function public.set_active_organization(uuid) is
  'Persists the authenticated user''s selected organization after validating '
  'a live membership and operational organization. The client must refresh '
  'the Supabase Auth session before RLS sees the new active_org_id claim.';

revoke execute
  on function public.set_active_organization(uuid)
  from anon, service_role, public;

grant execute
  on function public.set_active_organization(uuid)
  to authenticated;


-- =====================================================================
-- SECTION 005 — Protect sensitive public.users fields
-- =====================================================================

-- Migration 0010 granted table-wide mutation privileges to authenticated.
-- Replace those grants with the only direct profile edit currently allowed.
-- Email, status, platform-admin state, selected organization, identity keys,
-- soft-delete state, and audit columns remain server-controlled.
revoke insert, update, delete
  on table public.users
  from authenticated;

grant update (full_name)
  on table public.users
  to authenticated;


-- =====================================================================
-- SECTION 006 — Enforce live profile and organization state in RLS
-- =====================================================================

-- A token can remain valid after an Operro profile or organization is
-- suspended. Revalidate those mutable states inside the live authorization
-- helpers so a stale active_org_id claim cannot keep ordinary tenant access
-- alive. The frozen platform-admin bypass remains intentionally unchanged.
create or replace function app.has_membership()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app.is_platform_admin() or exists (
    select 1
    from public.users as u
    join public.memberships as m
      on m.user_id = u.id
    join public.organizations as o
      on o.id = m.organization_id
    where u.id = app.fn_current_user_id()
      and u.status = 'active'
      and u.deleted_at is null
      and m.organization_id = app.fn_active_organization()
      and m.status = 'active'
      and m.deleted_at is null
      and o.status in ('trial', 'active')
      and o.deleted_at is null
  );
$$;

comment on function app.has_membership() is
  'Checks a live user profile, active membership, and operational active organization. '
  'Platform admins retain the frozen architecture bypass.';

create or replace function app.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app.is_platform_admin() or exists (
    select 1
    from public.users as u
    join public.memberships as m
      on m.user_id = u.id
    join public.organizations as o
      on o.id = m.organization_id
    join public.role_permissions as rp
      on rp.organization_id = m.organization_id
     and rp.role_id = m.role_id
    join public.permissions as p
      on p.id = rp.permission_id
    where u.id = app.fn_current_user_id()
      and u.status = 'active'
      and u.deleted_at is null
      and m.organization_id = app.fn_active_organization()
      and m.status = 'active'
      and m.deleted_at is null
      and o.status in ('trial', 'active')
      and o.deleted_at is null
      and p.key = perm
  );
$$;

comment on function app.has_permission(text) is
  'Checks a permission only for a live user, active membership, and operational active organization. '
  'Platform admins retain the frozen architecture bypass.';

create or replace function app.has_branch(p_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app.is_platform_admin()
      or (
        app.has_membership()
        and (
          app.has_permission('branches.all')
          or exists (
            select 1
            from public.memberships as m
            join public.membership_branch_access as mba
              on mba.organization_id = m.organization_id
             and mba.membership_id = m.id
            where m.user_id = app.fn_current_user_id()
              and m.organization_id = app.fn_active_organization()
              and m.status = 'active'
              and m.deleted_at is null
              and mba.branch_id = p_branch
          )
        )
      );
$$;

comment on function app.has_branch(uuid) is
  'Checks branch access only after live membership and organization validation. '
  'Platform admins retain the frozen architecture bypass.';


-- =====================================================================
-- SECTION 007 — Isolate Auth-hook RLS from application policies
-- =====================================================================

-- The frozen identity policies were created without TO clauses, so PostgreSQL
-- treats them as applying to PUBLIC. Scope them to the application role before
-- adding dedicated supabase_auth_admin policies. This preserves authenticated
-- behavior while preventing the Auth hook from evaluating JWT-dependent helper
-- policies or requiring access to the private app schema.
alter policy organizations_read
  on public.organizations
  to authenticated;

alter policy organizations_write
  on public.organizations
  to authenticated;

alter policy users_read
  on public.users
  to authenticated;

alter policy users_write
  on public.users
  to authenticated;

alter policy memberships_read
  on public.memberships
  to authenticated;

alter policy memberships_write
  on public.memberships
  to authenticated;


-- =====================================================================
-- SECTION 008 — Supabase Custom Access Token Hook
-- =====================================================================

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $$
declare
  v_user_id uuid;
  v_profile_is_active boolean := false;
  v_is_platform_admin boolean := false;
  v_preferred_organization_id uuid;
  v_active_organization_id uuid;
  v_claims jsonb;
  v_app_metadata jsonb;
begin
  if event is null
     or jsonb_typeof(event) <> 'object'
     or nullif(event ->> 'user_id', '') is null then
    raise exception
      using
        errcode = '22023',
        message = 'invalid_custom_access_token_event';
  end if;

  begin
    v_user_id := (event ->> 'user_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception
        using
          errcode = '22023',
          message = 'invalid_custom_access_token_user_id';
  end;

  if event -> 'claims' is null
     or jsonb_typeof(event -> 'claims') <> 'object' then
    raise exception
      using
        errcode = '22023',
        message = 'invalid_custom_access_token_claims';
  end if;

  -- Start from the complete Supabase claims object. Only the two Operro-owned
  -- claim locations are replaced; all required and optional Supabase claims
  -- remain untouched.
  v_claims := event -> 'claims';

  select
    true,
    u.is_platform_admin,
    u.active_organization_id
  into
    v_profile_is_active,
    v_is_platform_admin,
    v_preferred_organization_id
  from public.users as u
  where u.id = v_user_id
    and u.status = 'active'
    and u.deleted_at is null;

  v_profile_is_active := coalesce(v_profile_is_active, false);
  v_is_platform_admin := coalesce(v_is_platform_admin, false);

  -- Never trust an incoming custom claim. Remove it first, then add only a
  -- database-validated organization for an active application profile.
  v_claims := v_claims - 'active_org_id';

  if v_profile_is_active then
    select m.organization_id
    into v_active_organization_id
    from public.memberships as m
    join public.organizations as o
      on o.id = m.organization_id
    where m.user_id = v_user_id
      and m.status = 'active'
      and m.deleted_at is null
      and o.status in ('trial', 'active')
      and o.deleted_at is null
    order by
      case
        when m.organization_id = v_preferred_organization_id then 0
        else 1
      end,
      m.created_at,
      m.id
    limit 1;
  end if;

  if v_active_organization_id is not null then
    v_claims := jsonb_set(
      v_claims,
      '{active_org_id}',
      to_jsonb(v_active_organization_id::text),
      true
    );
  end if;

  -- Preserve the original app_metadata object and every existing key, while
  -- replacing the server-owned Operro admin flag from public.users.
  if jsonb_typeof(v_claims -> 'app_metadata') = 'object' then
    v_app_metadata := v_claims -> 'app_metadata';
  else
    v_app_metadata := '{}'::jsonb;
  end if;

  v_app_metadata := jsonb_set(
    v_app_metadata,
    '{is_platform_admin}',
    to_jsonb(v_is_platform_admin),
    true
  );

  v_claims := jsonb_set(
    v_claims,
    '{app_metadata}',
    v_app_metadata,
    true
  );

  return jsonb_set(event, '{claims}', v_claims, true);
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Preserves Supabase JWT claims, replaces active_org_id with a live validated '
  'organization, and sets app_metadata.is_platform_admin from public.users.';

revoke execute
  on function public.custom_access_token_hook(jsonb)
  from anon, authenticated, service_role, public;

grant usage
  on schema public
  to supabase_auth_admin;

grant execute
  on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

-- Remove any pre-existing direct table SELECT before granting the exact
-- columns required by the hook.
revoke select
  on table public.users,
           public.memberships,
           public.organizations
  from supabase_auth_admin;

-- Column-level SELECT is sufficient for the hook and avoids exposing complete
-- identity, membership, or organization rows to the Auth database role.
grant select (
  id,
  active_organization_id,
  is_platform_admin,
  status,
  deleted_at
)
  on table public.users
  to supabase_auth_admin;

grant select (
  id,
  user_id,
  organization_id,
  status,
  created_at,
  deleted_at
)
  on table public.memberships
  to supabase_auth_admin;

grant select (
  id,
  status,
  deleted_at
)
  on table public.organizations
  to supabase_auth_admin;


-- =====================================================================
-- SECTION 009 — Dedicated RLS access for the Auth hook
-- =====================================================================

create policy users_auth_hook_read
on public.users
as permissive
for select
to supabase_auth_admin
using (true);

create policy memberships_auth_hook_read
on public.memberships
as permissive
for select
to supabase_auth_admin
using (true);

create policy organizations_auth_hook_read
on public.organizations
as permissive
for select
to supabase_auth_admin
using (true);


-- =====================================================================
-- SECTION 098 — Required external verification contract
-- =====================================================================
-- Run these in a separate test migration/file against PostgreSQL 16 and the
-- real non-superuser roles. Do not convert these into superuser-only checks.
--
--  1. Existing auth user is present in public.users after backfill.
--  2. New auth user is automatically synchronized.
--  3. User with no active membership receives no active_org_id.
--  4. User with one live membership receives that organization.
--  5. User with multiple memberships receives the persisted valid selection.
--  6. Invalid persisted selection falls back deterministically and safely.
--  7. Suspended/removed/deleted membership is rejected.
--  8. Suspended/deleted organization is rejected.
--  9. Authenticated user cannot select another tenant's organization.
-- 10. Authenticated user cannot update is_platform_admin, email, status,
--     active_organization_id, deleted_at, or audit fields directly.
-- 11. Hook preserves required claims and unrelated optional/custom claims.
-- 12. Hook preserves existing app_metadata keys and replaces only
--     app_metadata.is_platform_admin from public.users.
-- 13. Deactivated/deleted/missing public user receives false admin and no org.
-- 14. For a non-platform user, a stale JWT cannot pass app.has_membership(),
--     app.has_permission(), or app.has_branch() after the user or organization
--     becomes non-operational.
-- 15. Organization switch changes persisted state but old JWT remains active
--     until session refresh; refreshed JWT contains the new claim.
-- 16. Existing cross-tenant and branch RLS regression suite remains green.
-- 17. supabase_auth_admin can execute the hook but cannot select ungranted
--     columns or execute application RPCs.
-- 18. anon cannot execute either public function.
-- 19. Frozen migration files/checksums remain unchanged.
--
-- The migration is not approved for staging merely because it applies. All
-- behavior above must pass, including direct SET ROLE authenticated tests.


-- =====================================================================
-- SECTION 099 — Manual rollback notes (documentation only)
-- =====================================================================
-- PRECONDITION: Disable Authentication > Hooks > Custom Access Token first.
-- Then, in a controlled maintenance transaction and reverse dependency order:
--
--   drop policy if exists organizations_auth_hook_read on public.organizations;
--   drop policy if exists memberships_auth_hook_read on public.memberships;
--   drop policy if exists users_auth_hook_read on public.users;
--
--   alter policy organizations_read  on public.organizations to public;
--   alter policy organizations_write on public.organizations to public;
--   alter policy users_read          on public.users         to public;
--   alter policy users_write         on public.users         to public;
--   alter policy memberships_read    on public.memberships   to public;
--   alter policy memberships_write   on public.memberships   to public;
--
--   -- Restore app.has_membership(), app.has_permission(text), and
--   -- app.has_branch(uuid) from frozen migration 20260721001000 before
--   -- removing the remaining 01400 objects.
--
--   drop function if exists public.custom_access_token_hook(jsonb);
--   drop function if exists public.set_active_organization(uuid);
--   drop trigger if exists trg_auth_users_sync on auth.users;
--   drop function if exists app.tg_sync_auth_user();
--   drop trigger if exists trg_users_validate_active_organization on public.users;
--   drop function if exists app.tg_validate_active_organization();
--   drop index if exists public.idx_users_active_organization;
--   alter table public.users drop constraint if exists fk_users_active_organization;
--   alter table public.users drop column if exists active_organization_id;
--
-- Reassess public.users grants before restoring the old table-wide authenticated
-- mutation privileges; those broad grants were intentionally removed here.

commit;
