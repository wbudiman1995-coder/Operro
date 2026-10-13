-- Read-only post-condition checks for the hosted-staging access QC (docs/runbooks/STAGING_ACCESS_QC.md).
--
-- Run it on the STAGING database after you have done the manual invitation and multi-organization steps, as a role that can read the
-- tables (the project owner on staging). It is a set of SELECT statements: it writes nothing, creates no invitation, sends no
-- mail and returns no token, token hash or e-mail address. It checks what the database can prove; it cannot prove that an e-mail was
-- delivered or that a person clicked a link. Paste the result table into the evidence record.
--
--   psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/runbooks/staging_access_checks.sql
--
-- Every row is (check_name, ok, detail). A check with ok = false is a finding. Rows with ok = null are information for the reviewer.
select * from (
  -- 1. invitation tokens are stored only as SHA-256 hashes (64 hex characters), never as the link
  select 'invitation tokens stored as sha-256 hashes only'::text as check_name,
         not exists (select 1 from public.platform_access_invitations where token_hash !~ '^[0-9a-f]{64}$') as ok,
         (select count(*) from public.platform_access_invitations)::text || ' invitations checked' as detail

  union all
  -- 2. an invitation lives seven days
  select 'every invitation expires exactly seven days after it was issued',
         not exists (select 1 from public.platform_access_invitations where expires_at - created_at <> interval '7 days'),
         (select count(*) from public.platform_access_invitations where expires_at - created_at <> interval '7 days')::text || ' with another lifetime'

  union all
  -- 3. only one pending invitation per address and organization (re-issuing revokes the older link)
  select 'at most one pending invitation per address and organization',
         not exists (select 1 from public.platform_access_invitations where status = 'pending' group by organization_id, email having count(*) > 1),
         (select count(*) from (select 1 from public.platform_access_invitations where status = 'pending' group by organization_id, email having count(*) > 1) d)::text || ' duplicates'

  union all
  -- 4. every accepted invitation produced exactly the membership it named
  select 'accepted invitations match an active-or-suspended membership with the invited role',
         not exists (
           select 1 from public.platform_access_invitations i
            where i.status = 'accepted'
              and not exists (select 1 from public.memberships m join public.roles r on r.id = m.role_id and r.organization_id = m.organization_id
                               where m.organization_id = i.organization_id and m.user_id = i.accepted_by and r.name = i.role_name)),
         (select count(*) from public.platform_access_invitations i where i.status = 'accepted')::text || ' accepted invitations'

  union all
  -- 5. an Admin invitation never made an owner, and Admin roles hold neither role nor user management
  select 'no Admin role holds roles.manage or users.manage',
         not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
                      where r.name = 'Admin' and p.key in ('roles.manage', 'users.manage')),
         (select count(*) from public.roles where name = 'Admin')::text || ' Admin roles checked'

  union all
  -- 6. no pending invitation points at a suspended workspace
  select 'no pending invitation for a suspended workspace',
         not exists (select 1 from public.platform_access_invitations i join public.organizations o on o.id = i.organization_id
                      where i.status = 'pending' and i.expires_at > now() and o.status = 'suspended'),
         (select count(*) from public.organizations where status = 'suspended' and deleted_at is null)::text || ' suspended workspaces'

  union all
  -- 7. every trial or active workspace has an active business owner (a gap is a finding unless an owner invitation is still waiting)
  select 'every trial or active workspace has an active owner or a waiting owner invitation',
         not exists (
           select 1 from public.organizations o
            where o.deleted_at is null and o.status in ('trial','active')
              and not exists (select 1 from public.memberships m join public.roles r on r.id = m.role_id and r.organization_id = m.organization_id and r.deleted_at is null
                               where m.organization_id = o.id and m.status = 'active' and m.deleted_at is null and r.name in ('Pemilik','Owner','Pemilik Demo'))
              and not exists (select 1 from public.platform_access_invitations i where i.organization_id = o.id and i.role_name = 'Pemilik' and i.status = 'pending' and i.expires_at > now())),
         (select count(*) from public.organizations where deleted_at is null and status in ('trial','active'))::text || ' workspaces checked'

  union all
  -- 8. information: multi-organization people and suspended memberships (expected to be non-zero only after the QC steps)
  select 'information: people active in more than one organization', null,
         (select count(*) from (select user_id from public.memberships where status = 'active' and deleted_at is null group by user_id having count(distinct organization_id) > 1) s)::text
  union all
  select 'information: suspended memberships', null, (select count(*) from public.memberships where status <> 'active' and deleted_at is null)::text
  union all
  select 'information: schema version', null, app.schema_version()
) checks
order by (ok is not distinct from false) desc, check_name;
