# QC 1-4 closeout checklist

This checklist turns every requested QC item into a release criterion. “Verified” means covered by an automated contract/build check; provider login also requires the configured Google OAuth credentials to be exercised by a real Google account.

## 1. Sign-in, workspace, and permissions

- [x] Platform owner creates an active workspace and internal unique slug without asking for a slug.
- [x] Platform owner links a business owner; business owner can issue an Admin-only invitation for the same workspace.
- [x] Invitation acceptance has no password-registration path and requires the invited email.
- [x] Email/password sign-in and sign-out remain available; Google OAuth has an application callback and sign-in controls.
- [x] Switching workspaces refreshes the active-organization claim before navigation.
- [x] Admin capability restrictions are resolved server-side and navigation follows those capabilities.
- [x] Groomers use one-time private codes, can see only their own work, and use the restricted photo workflow without email invitation.
- [x] Saved landing preference invalidates the post-login redirect.

## 2. Platform owner controls

- [x] Workspace slug is generated internally and collision-safe.
- [x] New workspaces and subscriptions begin active rather than as a trial prompt.
- [x] Invitation links do not offer account registration.
- [x] Organization deletion is owner-only and requires the exact organization confirmation text.
- [x] Suspension stores and displays a reason; reactivation uses the same guarded lifecycle control.
- [x] Operro Helper is explicitly workspace-scoped: no platform access and no payroll access. It is not a platform-admin role.

## 3. Team

- [x] Archiving a groomer is refused while future active bookings exist.
- [x] Archived groomers are separated from active team members and have a dedicated, read-only booking-history screen.

## 4. Catalog, branches, and navigation

- [x] Customer/pet creation validates active pet types and size bands; legacy workspaces are repaired with the required seed records.
- [x] The HomePaw-only starter is absent from the tenant catalog.
- [x] Business owners can change size mode and manage size bands; band updates preserve existing references.
- [x] New pet types can be added, then priced per service in the main table.
- [x] The main catalog table edits service name, category, availability, price, and duration; the previous per-service editor is not rendered.
- [x] New service rows and categories can be created from the catalog.
- [x] Dynamic dog-size bands can be added, renamed, archived, and deleted with reference safeguards.
- [x] A business owner can create another branch.
- [x] Under the selected role-based navigation approach: groomers see only their personal schedule, while Operations and Visits remain manager tools; they are not shown to groomers.

## Verification gate

- [x] Typecheck, lint, QC contract tests, and a production build must pass before release.
- [x] Database migration is applied to the linked Supabase project.
- [x] Production deployment must report Ready and return HTTP 200.
