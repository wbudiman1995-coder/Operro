-- Restore the permissive tenant boundary required by the restrictive
-- module and capability policies on customer-program tables.
--
-- PostgreSQL combines permissive policies with OR, then ANDs restrictive
-- policies over that result. These tables previously had only restrictive
-- policies, so authenticated tenants could never see or mutate any row.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'membership_plans',
    'customer_memberships',
    'packages',
    'customer_packages',
    'customer_package_ledger',
    'loyalty_accounts',
    'loyalty_ledger',
    'wallet_accounts',
    'wallet_ledger',
    'referrals'
  ]
  loop
    execute format('drop policy if exists %1$s_org_isolation on public.%1$s', table_name);
    execute format($policy$
      create policy %1$s_org_isolation on public.%1$s
      for all
      using (
        app.is_platform_admin()
        or (
          organization_id = app.fn_active_organization()
          and app.has_membership()
        )
      )
      with check (
        app.is_platform_admin()
        or (
          organization_id = app.fn_active_organization()
          and app.has_membership()
        )
      )
    $policy$, table_name);
  end loop;
end
$$;
