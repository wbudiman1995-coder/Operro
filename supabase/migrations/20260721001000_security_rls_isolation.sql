-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        0010_security_rls_isolation
-- Milestone        8A — Security / RLS (Isolation Engine)
-- Purpose          Activate PostgreSQL as the authorization engine for
--                  TENANT ISOLATION, MEMBERSHIP VALIDATION, and BRANCH
--                  ISOLATION. Introduces the context helpers and installs
--                  permissive RLS policies on every table (deny-all until
--                  now). Feature + permission enforcement is layered as
--                  RESTRICTIVE policies in Milestone 8B.
-- Dependencies     0001–0009 (all domain tables, RLS already ENABLED).
-- Objects Created  app.has_membership(), app.has_permission(text),
--                  app.has_branch(uuid); role GRANTs; RLS policies on all
--                  tables (catalogs, identity, and every tenant table).
-- Objects Modified Adds policies to tables whose RLS was enabled deny-all.
-- RLS Policies     Catalogs: read-all authenticated, write platform-admin.
--                  Tenant tables: org == active_org AND active membership
--                  (+ branch access where branch-scoped). Platform admin
--                  bypasses. service_role bypasses RLS by role (Supabase).
-- Breaking Changes None (adds access to previously deny-all tables).
-- Rollback         DROP the added policies + 3 helper functions.
-- Notes            Validated as a NON-SUPERUSER role (superuser bypasses
--                  RLS). Fine-grained capability (feature/permission) checks
--                  arrive in 8B as restrictive (AND-ed) policies.
-- =====================================================================


-- =====================================================================
-- SECTION 001 — Context helpers (SECURITY DEFINER; resolve the request)
-- =====================================================================
create or replace function app.has_membership()
returns boolean security definer set search_path = app, public
language sql stable as $$
  select app.is_platform_admin() or exists (
    select 1 from public.memberships m
    where m.user_id = app.fn_current_user_id()
      and m.organization_id = app.fn_active_organization()
      and m.status = 'active' and m.deleted_at is null);
$$;

create or replace function app.has_permission(perm text)
returns boolean security definer set search_path = app, public
language sql stable as $$
  select app.is_platform_admin() or exists (
    select 1 from public.memberships m
    join public.role_permissions rp on rp.organization_id = m.organization_id and rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id
    where m.user_id = app.fn_current_user_id()
      and m.organization_id = app.fn_active_organization()
      and m.status = 'active' and m.deleted_at is null
      and p.key = perm);
$$;

create or replace function app.has_branch(p_branch uuid)
returns boolean security definer set search_path = app, public
language sql stable as $$
  select app.is_platform_admin()
      or app.has_permission('branches.all')
      or exists (
        select 1 from public.memberships m
        join public.membership_branch_access mba
          on mba.organization_id = m.organization_id and mba.membership_id = m.id
        where m.user_id = app.fn_current_user_id()
          and m.organization_id = app.fn_active_organization()
          and m.status = 'active' and mba.branch_id = p_branch);
$$;


-- =====================================================================
-- SECTION 002 — Role grants (Supabase roles). service_role bypasses RLS.
-- =====================================================================
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;


-- =====================================================================
-- SECTION 003 — Global catalog policies (read-all authenticated; write admin)
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['permissions','modules','features','plans','plan_modules','plan_features']
  loop
    execute format('create policy %1$s_read on public.%1$s for select using (true);', t);
    execute format('create policy %1$s_admin_write on public.%1$s for all using (app.is_platform_admin()) with check (app.is_platform_admin());', t);
  end loop;
end $$;


-- =====================================================================
-- SECTION 004 — Tenant isolation policies (generic, dynamic)
-- =====================================================================
-- org-scoped (no branch gate)
do $$
declare t text;
begin
  foreach t in array array[
    'branches','roles','role_permissions','membership_branch_access',
    'subscriptions','organization_modules','organization_features',
    'customers','pets','service_catalog','product_catalog',
    'booking_recurrence','booking_resources','grooming_jobs','boarding_stays',
    'service_products','sop_templates','order_items','invoice_lines','refunds',
    'tax_rates','commission_rules','commission_entries','staff_compensation','payroll_items']
  loop
    execute format($f$
      create policy %1$s_org_isolation on public.%1$s for all
      using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()))
      with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()));
    $f$, t);
  end loop;
end $$;

-- branch-scoped (branch_id NOT NULL) -> add branch access
do $$
declare t text;
begin
  foreach t in array array[
    'resources','resource_availability','bookings',
    'inventory_movements','inventory_levels','tasks',
    'orders','invoices','payments']
  loop
    execute format($f$
      create policy %1$s_branch_isolation on public.%1$s for all
      using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership() and app.has_branch(branch_id)))
      with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership() and app.has_branch(branch_id)));
    $f$, t);
  end loop;
end $$;

-- branch-nullable -> branch gate only when a branch is set
do $$
declare t text;
begin
  foreach t in array array['financial_ledger','payroll_runs','expenses']
  loop
    execute format($f$
      create policy %1$s_branch_isolation on public.%1$s for all
      using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership() and (branch_id is null or app.has_branch(branch_id))))
      with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership() and (branch_id is null or app.has_branch(branch_id))));
    $f$, t);
  end loop;
end $$;


-- =====================================================================
-- SECTION 005 — Special tables (identity)
-- =====================================================================
-- organizations: a user may READ every org they are an active member of
-- (workspace switcher); WRITE requires settings.manage on the active org.
create policy organizations_read on public.organizations for select
  using (app.is_platform_admin() or exists (
    select 1 from public.memberships m
    where m.user_id = app.fn_current_user_id() and m.organization_id = public.organizations.id
      and m.status = 'active' and m.deleted_at is null));
create policy organizations_write on public.organizations for all
  using (app.is_platform_admin() or (id = app.fn_active_organization() and app.has_permission('settings.manage')))
  with check (app.is_platform_admin() or (id = app.fn_active_organization() and app.has_permission('settings.manage')));

-- users: self, or co-members of any shared org; write self or admin.
create policy users_read on public.users for select
  using (app.is_platform_admin() or id = app.fn_current_user_id() or exists (
    select 1 from public.memberships ms
    join public.memberships mo on mo.organization_id = ms.organization_id
    where ms.user_id = app.fn_current_user_id() and ms.status = 'active'
      and mo.user_id = public.users.id and mo.status = 'active'));
create policy users_write on public.users for all
  using (app.is_platform_admin() or id = app.fn_current_user_id())
  with check (app.is_platform_admin() or id = app.fn_current_user_id());

-- memberships: own memberships across ALL orgs (switcher), plus co-members
-- in the active org; writes need users.manage in the active org.
create policy memberships_read on public.memberships for select
  using (app.is_platform_admin() or user_id = app.fn_current_user_id()
         or (organization_id = app.fn_active_organization() and app.has_membership()));
create policy memberships_write on public.memberships for all
  using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_permission('users.manage')))
  with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_permission('users.manage')));

-- =====================================================================
-- END 0010_security_rls_isolation
-- =====================================================================
