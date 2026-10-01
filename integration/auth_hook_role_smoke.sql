-- Run after integration/platform_access_qc.sh against its disposable PG16 DB.
-- Supabase Auth invokes this hook as supabase_auth_admin, not postgres.
begin;
set local role supabase_auth_admin;
do $$
declare v_claims jsonb;
begin
  if has_table_privilege(current_user, 'public.users', 'select') then
    raise exception 'fixture_invalid_auth_role_has_direct_user_read';
  end if;
  v_claims := public.custom_access_token_hook(jsonb_build_object(
    'user_id', 'a1000000-0000-4000-8000-000000000001',
    'claims', jsonb_build_object(
      'sub', 'a1000000-0000-4000-8000-000000000001',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  ));
  if (v_claims #>> '{claims,app_metadata,is_platform_admin}')::boolean is distinct from true then
    raise exception 'auth_hook_platform_claim_missing';
  end if;
  raise notice 'PASS Supabase Auth role invokes token hook without direct table SELECT';
end;
$$;
rollback;
