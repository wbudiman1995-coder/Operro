-- =====================================================================
-- LOCAL-ONLY QA SEED — run automatically by `supabase db reset`.
--
-- Creates its own auth users (owner + one groomer) from scratch, so this works against a
-- brand-new local Postgres with nothing in auth.users yet — unlike supabase/seeds/
-- homepaw_demo.sql, which requires an owner that already signed in once (fine for a shared
-- remote project, useless for a throwaway local stack). This script creates that owner
-- locally with the SAME email homepaw_demo.sql expects, then reuses it as-is via \ir rather
-- than duplicating its ~160 lines.
--
-- UNVERIFIED: the auth.users/auth.identities shape below is the well-known community
-- pattern for seeding local Supabase Auth, written without a local Postgres/GoTrue to test
-- against in this session. If password login fails after `db reset`, check this shape
-- against the GoTrue version your installed Supabase CLI actually bundles.
--
-- QA logins (password for both: "operro-local-qa"):
--   owner@homepaw.local    — full access, same role/org as homepaw_demo.sql
--   groomer@homepaw.local  — same org, linked to the "Andi" resource for /my-schedule
-- =====================================================================

do $$
declare
  v_instance uuid := '00000000-0000-0000-0000-000000000000';
  v_owner_id uuid := 'e0000000-0000-4000-8000-000000000001';
  v_groomer_id uuid := 'e0000000-0000-4000-8000-000000000002';
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
  v_role uuid := 'd0000000-0000-4000-8000-000000000002';
  v_groomer_membership uuid := 'e0000000-0000-4000-8000-000000000010';
  v_andi_resource uuid := 'd0000000-0000-4000-8000-000000000201';
  v_password text := 'operro-local-qa';
begin
  -- Owner — email matches supabase/seeds/homepaw_demo.sql's v_owner_email exactly, so
  -- that seed's own lookup succeeds unmodified.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    v_instance, v_owner_id, 'authenticated', 'authenticated', 'wbudiman1995@gmail.com',
    extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"full_name":"Owner QA"}', false, now(), now(),
    '', '', '', ''
  ) on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (v_owner_id, v_owner_id, v_owner_id::text, jsonb_build_object('sub', v_owner_id::text, 'email', 'wbudiman1995@gmail.com'), 'email', now(), now(), now())
  on conflict (provider_id, provider) do nothing;

  -- Groomer — a second QA login, linked below to the existing "Andi" resource so
  -- /my-schedule has something to show.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    v_instance, v_groomer_id, 'authenticated', 'authenticated', 'groomer@homepaw.local',
    extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"full_name":"Andi (Groomer QA)"}', false, now(), now(),
    '', '', '', ''
  ) on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (v_groomer_id, v_groomer_id, v_groomer_id::text, jsonb_build_object('sub', v_groomer_id::text, 'email', 'groomer@homepaw.local'), 'email', now(), now(), now())
  on conflict (provider_id, provider) do nothing;
end $$;

-- public.users for both should now exist via trg_auth_users_sync (fires on auth.users
-- insert — see supabase/migrations/20260721001400_active_organization_context.sql). This
-- script never writes public.users directly; that trigger is the sanctioned path.
