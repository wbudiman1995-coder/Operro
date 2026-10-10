-- Committed (not rolled back) fixture for the two-session cleanup race. Run only against a disposable gate database.
\set ON_ERROR_STOP on
insert into public.organizations (id, name, slug, status) values ('c8f00000-0000-4000-8000-000000000001', 'Race A', 'race-a-cleanup', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  values ('c8f00000-0000-4000-8000-000000000001', 'active', now() - interval '1 day', now() + interval '1 year');
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select 'c8f00000-0000-4000-8000-000000000001', m.id, true, 'override' from public.modules m;
insert into public.roles (id, organization_id, name) values ('c8f00000-0000-4000-8000-000000000011', 'c8f00000-0000-4000-8000-000000000001', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c8f00000-0000-4000-8000-000000000001', 'c8f00000-0000-4000-8000-000000000011', id from public.permissions where key in ('settings.manage');
insert into auth.users (id, email, raw_user_meta_data) values ('c8f00000-0000-4000-8000-000000000021', 'owner@race-cleanup.test', '{}');
update public.users set status = 'active' where id = 'c8f00000-0000-4000-8000-000000000021';
insert into public.memberships (user_id, organization_id, role_id, status)
  values ('c8f00000-0000-4000-8000-000000000021', 'c8f00000-0000-4000-8000-000000000001', 'c8f00000-0000-4000-8000-000000000011', 'active');
insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, metadata) values
  ('c8f00000-0000-4000-8000-0000000b0001', 'c8f00000-0000-4000-8000-000000000001', 'styling-references', 'c8f00000-0000-4000-8000-000000000001/ref/1.jpg', 'f1',
   jsonb_build_object('kind', 'styling_reference', 'expires_at', to_char(now() - interval '3 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
  ('c8f00000-0000-4000-8000-0000000b0002', 'c8f00000-0000-4000-8000-000000000001', 'styling-references', 'c8f00000-0000-4000-8000-000000000001/ref/2.jpg', 'f2',
   jsonb_build_object('kind', 'styling_reference', 'expires_at', to_char(now() - interval '3 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
-- The preview is a committed fact both sessions can see.
select set_config('request.jwt.claims', json_build_object('sub', 'c8f00000-0000-4000-8000-000000000021', 'role', 'authenticated', 'active_org_id', 'c8f00000-0000-4000-8000-000000000001')::text, false);
select app.storage_cleanup_preview(50);
