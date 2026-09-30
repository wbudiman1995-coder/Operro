# Operro platform and workspace access handoff

Branch: `feat/platform-org-access-qc` (based on `fa157be`). This change is not a deployed release until both new SQL migrations have run on the target Supabase project and its Vercel deployment uses this commit.

## What was added

- `/platform`: available only to the existing active `wbudiman1995@gmail.com` account. It provisions an organization with a branch and roles, issues one-time email-bound invitation links, adjusts access per organization, sets a business's manual payment status, suspends/reactivates a business, reviews capacity requests, and shows project-wide database/file usage. The page links to the verified Supabase organization Usage page and Vercel team Usage page.
- `/accept/[token]`: invitees sign in or create an Auth account, verify their email if needed, then claim the one-time invitation. The link is displayed for the Operro owner to copy or send using the email app; no automatic email service is configured.
- `/settings/access`: each business owner manages existing staff access and the Admin permission checklist for that business. Only the Operro platform owner issues new account links. The Operro support role has operational access only to organizations it has been invited into and no payroll permission.
- `/catalog`: business owners can change the XS/S/M/L/XL weight boundaries; authorized catalog managers can edit the per-size price and duration matrix that was already present. Cat remains separate. New pet classifications use the organization's current thresholds.
- Groomers receive their own `/my-schedule` link from the team profile. They see assigned customers and jobs, with photo evidence under their own schedule; a restrictive database policy prevents reading other groomers' customers and jobs.
- Public registration immediately validates a pasted Google Maps URL, shows a red error for an invalid URL, and submits pets for server-side weight classification. The `/customers` page points admins to `/customers/onboarding` to amend and accept submissions.
- Calendar booking cards display only the customer/owner name and kabupaten/kota.
- `/settings/storage` shows that business's file usage and capacity-request status. Requests appear in `/platform` for manual review and billing. Project-wide Supabase and Vercel usage is visible only in `/platform`.

## Database and security

Apply `20261019100000_platform_org_access.sql` then `20261019110000_org_dog_size_boundaries.sql`. The first migration bootstraps the already-existing active Operro owner row to `is_platform_admin=true`; the live project currently has that flag `false`. Do not deploy the new UI without both migrations. Existing auth sessions may need a sign-out/sign-in so the JWT reflects the new flag.

Invitations store a token hash and are bound to one verified email for seven days. Membership, role, and subscription writes are RPC-only. The business Admin checklist excludes access-management permissions. Support roles exclude payroll, finance reporting, and access-management permissions. Suspended organizations are blocked from workspace reads and public registration.

## Verification completed on the isolated branch

- PostgreSQL 16 full migration lineage plus `integration/platform_access_smoke.sql` passed. This included a populated-owner bootstrap, wrong-email and replay rejection, business and support role checks, groomer-assignment RLS, resource-retirement cleanup, stale-token denial after deactivation, subscription suspension, and custom size boundaries.
- The populated HomePaw upgrade rehearsal applied all 32 post-baseline migrations, including these two, with organization/customer/pet/booking counts unchanged (`2,6,7,6`); see `docs/handoffs/logs/INTEGRATION/populated-upgrade.log`.
- The existing assembly, package reservation, and payroll SQL suites passed against the isolated PostgreSQL 16 database.
- Web typecheck, lint, production build, batch1a (109/109), batch1b (314/314), and booking (14/14) passed.
- A QC agent reviewed access boundaries and identified issues with direct writes, deactivated-user claims, and groomer visibility. These were fixed and retested. It could not complete an additional final pass because its model usage limit was reached.
- The live Supabase project was read-only inspected: its last applied migration is `20261018120000`, and the existing Operro owner's `is_platform_admin` is `false`. The Supabase and Vercel Usage URLs were opened and verified.

## Live acceptance before treating this as released

1. Apply both migrations to the intended Supabase project, verify they appear in migration history, then sign out and sign in as the Operro owner.
2. Open `/platform`; prepare a disposable organization, create an invitation for a test email, and confirm another email cannot claim it. Do not invite real customers during QC.
3. Claim the test invite; confirm the business owner's `/settings/access` works, while a business Admin cannot alter its own access-management permissions.
4. Invite a support member and a groomer. Verify support can switch only into invited organizations and cannot open payroll. Link the groomer to its team resource; verify its own schedule and photo upload, and no other groomer's customers.
5. Confirm the catalog's XS/S/M/L/XL thresholds and price/duration edits persist. Register a pet by weight and check its stored size and booking price. Confirm cat remains separate.
6. Submit a public registration with an invalid then valid Maps link; check the red error, the submission review queue, amend/accept, and the resulting customer/pets.
7. Check a calendar event shows only owner name and kabupaten/kota. Check the storage request appears on `/platform`, and the business never sees project-wide usage.
8. Record a manual billing period, suspend the disposable organization, confirm access and registration are blocked, then reactivate it.

No new SQL migration or Vercel deployment was applied to the live project as part of the code verification above.
