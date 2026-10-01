-- Supabase Auth invokes the token hook as supabase_auth_admin. The prior
-- forward replacement accidentally made it SECURITY INVOKER while reading
-- public.users/memberships/organizations, to which that role has no SELECT.
-- Keep its existing narrow EXECUTE grant and fixed pg_catalog search path;
-- let the postgres-owned function perform only its existing claim lookup.
begin;
alter function public.custom_access_token_hook(jsonb) security definer;
commit;
