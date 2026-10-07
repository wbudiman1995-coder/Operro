# Operro project context for NgodingPakeAI

Snapshot date: 5 October 2026 (Asia/Jakarta)

This document is the compact orientation layer for planning Operro. It summarizes the product goal, current implementation, constraints, and remaining work. It does not replace the repository, migrations, tests, or detailed handoffs, and it must not be treated as proof that an unverified workflow is production-ready.

## 1. Product goal

Operro is a sellable, multi-tenant SaaS operations platform for Indonesian pet-grooming businesses. It must support both home-service and store operations. HomePaw, the owner's existing grooming business and application, is the primary product reference, but working Operro subsystems should be extended rather than rebuilt.

The product should let each business manage the full operating loop:

1. Public customer and multi-pet registration.
2. Admin review, correction, approval, and CRM creation.
3. Service catalog, species/breeds, dog-size bands, per-size prices and durations.
4. Calendar-first booking, recurring bookings, groomer assignment, route/location context, and availability.
5. Attendance, grooming status, photo evidence, complaints, and manual visits.
6. Per-pet services and add-ons, packages/memberships, invoices, payments, refunds, and follow-ups.
7. Payroll calculation, review, publication, and exports.
8. Business configuration, access control, storage requests, auditability, backup, reconciliation, and recovery.

Booking, package balance, invoice, payment, and payroll calculations must agree. Historical financial and operational snapshots must remain stable when catalog data later changes.

## 2. Users and authority model

- **Operro platform owner**: `wbudiman1995@gmail.com` is intentionally a superuser. The platform owner can provision organizations, identify each business owner, enter any business workspace (including suspended businesses), inspect or change its Admin permission checklist, manage Operro-to-business billing, and perform QC.
- **Business owner**: controls the business workspace, staff, catalog, configuration, and tenant Admin permission checklist.
- **Tenant Admin**: receives only explicitly granted business permissions and cannot grant itself access-management authority.
- **Bantuan Operro / platform support**: may help with approved operational support but must not see tenant payroll, finance reporting, or access management.
- **Groomer/staff**: receives branch- and capability-scoped operational access only.
- **Customer/applicant**: uses public intake without gaining tenant workspace access.

All tenant and branch scope must be derived and enforced server-side. Browser-provided organization identifiers are not authoritative.

## 3. Technology and repository

- Repository: `https://github.com/wbudiman1995-coder/Operro`
- Current local checkout: `C:\Users\DW_wi\Documents\ChatGPT\Operro`
- Current branch: `feat/platform-org-access-qc`
- Current commit: `8bef156aa745aa958c329adeae66b2cba7cf0ccf`
- Remote branch is currently aligned with that commit.
- Web application: Next.js 16, React 19, TypeScript, App Router.
- Backend: Supabase Postgres, Auth, Storage, RLS, SQL RPCs, and forward-only migrations.
- Workspace packages: shared SDK, backend services/repositories, and grooming preset.
- Production URL recorded by the current handoff: `https://operro-web.vercel.app/`
- Supabase project identifier recorded by prior handoffs: `tekgjynseoetoxestweb`; verify current deployment configuration before any production action.

Important repository areas:

- `apps/web/src/app/` — routes and server actions.
- `apps/web/src/components/` — operational UI.
- `apps/web/src/lib/` — domain loaders, authorization, pricing, schedule, payroll, invoice, export, and Supabase integration.
- `apps/web/test/` — focused contract and behavior tests.
- `supabase/migrations/` — schema, RLS, and RPC history; never rewrite an applied migration.
- `integration/` — database, concurrency, browser, migration-upgrade, and lifecycle checks.
- `packages/sdk/`, `packages/backend/`, `packages/preset-grooming/` — shared contracts and backend/preset logic.
- `docs/handoffs/` — detailed implementation history and evidence.
- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md` — authoritative 44-capability parity map for this snapshot.

Before editing Next.js code, read `apps/web/AGENTS.md` and the relevant installed Next.js documentation under `node_modules/next/dist/docs/`.

## 4. Current product state

The authoritative 1 October 2026 parity audit records **28 implemented, 13 partial, and 3 missing** capabilities. “Implemented” means a usable route/RPC and automated evidence exist; it does not guarantee that every live owner workflow has passed production QC.

Implemented or substantially implemented areas include:

- Multi-tenant identity, organization and branch access, invitation and workspace controls.
- Public onboarding with multi-pet intake, Indonesian administrative regions, map/location fields, and admin review.
- Customer search/filter/sort, Customer 360, history, packages, invoices, and multi-sheet export.
- Booking, recurring appointments, rescheduling, schedule layout, branch availability, blackouts, groomer assignment, and slot recommendations.
- Groomer workflows, attendance, evidence uploads, complaints, and visit tracking.
- Editable service catalog, categories, species/custom pet types, per-size pricing and durations, HomePaw starter data, and dog-size configuration.
- Packages/memberships, reservation and ledger behavior, renewals, expiry/follow-up queues, and reconciliation safeguards.
- Customer/service invoices, invoice documents/PDFs, discounts/charges, manual visits, payment review, proof uploads, and payment register.
- Payroll settings, immutable payroll snapshots, approval/publication, staff views, and XLSX/CSV exports.
- Retention and renewal follow-ups with role-aware access.
- Platform organization access, platform billing records/invoices, storage usage surfaces, and manual capacity requests.
- Audit, RLS, tenant isolation, migration, concurrency, and regression-test foundations.

Recent commits on the current branch added or clarified platform workspace access, platform billing, tenant controls, custom pet catalog behavior, CRM export, HomePaw registration/catalog/calendar work, and the remaining parity map.

## 5. Remaining product backlog

The priority is not to rebuild completed modules. Work should close evidence-backed gaps in small, coherent batches.

### Customer and pet operations

- Persistent customer code and safe CRM bulk edit.
- Safe Customer 360 editing.
- Standalone pet CRUD, coat profile, and wash counter.
- Owner-defined custom fields for customer and pet records, including definition versioning, privacy, search, and export behavior.

### Dashboard and preferences

- Dashboard period comparison, configurable cards, and acquisition-source ROI based on real available data.
- Per-user landing page, calendar/dashboard defaults, and language preferences.
- Remaining validated business preferences such as card visibility, notification duration, auto-log visit, and templates.

### Catalog and size model

- Complete and verify tenant-owned dynamic dog-size bands across catalog editing, booking pricing/duration, package eligibility, payroll, and historical snapshots.
- Preserve stable size keys and refuse unsafe deletion when active dependencies exist.
- Do not ship cosmetic controls that leave authoritative calculations on fixed XS–XL assumptions.

### Finance and audit

- Capital/cash-on-hand workflows and the complete finance export suite.
- Cross-entity audit-history review with clear labels.
- Unified read-only operational reconciliation for completed visits without valid invoices, issued invoices without matching payments, and published payroll whose sources were voided or missing.
- Reconciliation must surface discrepancies for manual review; it must never silently rewrite financial history.

### Communication

- Existing WhatsApp behavior produces per-record `wa.me` drafts and templates.
- A unified WhatsApp center requires a deliberate product decision covering customer consent, delivery state, rate limits, provider integration, and audit history. Do not implement automatic sending by assumption.

### Ownership, storage, and resilience

- Organization-wide backup containing configuration and actual storage objects, followed by a documented restore drill on an empty migrated project.
- Live multi-organization invitation and role QC.
- Secure per-organization database-byte accounting, scheduled cleanup, and capacity/billing automation; clearly distinguish internal estimates from Supabase/Vercel provider billing.
- Monitoring, recovery UI/runbooks, retention policy, alert ownership, and exercised recovery scenarios.

## 6. Known QC and release gaps

Before claiming full HomePaw parity or production readiness, verify at least:

1. A fresh independent-email owner invitation, wrong-email rejection, successful claim, and membership persistence until explicit suspension/revocation.
2. Platform-owner workspace switching and Admin-checklist management; tenant Admin denial; support denial for payroll/finance/access management.
3. Custom pet type and service category through registration, approval, Customer 360, booking, invoice pricing, and duration.
4. Tenant-scoped CRM exports with spreadsheet-formula injection protection for values beginning `=`, `+`, `-`, or `@`.
5. Platform billing lifecycle: period, amount, due date, issuance, PDF, business-owner view, paid lock, and suspended-business behavior.
6. Manual-visit invoice creation with the intended multi-line behavior and immutable retry/idempotency rules.
7. Payment proof/confirmation, grooming evidence upload/delete, invoice notes/WhatsApp output, visit invoicing, and large payment-register paging in a real browser.
8. Production sign-in for `wbudiman1995@gmail.com`; an earlier failure was addressed in code, but live success must be observed before it is claimed.
9. A populated-database migration-upgrade rehearsal plus cross-tenant and lower-role checks for every migration affecting access or finance.

## 7. Non-negotiable engineering rules

- Reuse existing HomePaw/Operro workflows and components when safe; avoid broad rewrites.
- Use forward-only migrations. Never edit old migrations that may already be applied.
- Keep RLS, RPC authorization, tenant isolation, and branch scope intact.
- Never expose a Supabase service-role key or trust browser-provided tenant scope.
- Preserve immutable invoice, package-ledger, payment, and payroll snapshots.
- Make retries idempotent and reject materially changed payloads under the same request key.
- Keep package availability consistent with held/reserved sessions and the append-only ledger.
- Treat database/provider usage meters honestly; do not present project-wide values as precise tenant billing.
- Do not create real invitations, invoices, production mutations, migrations, deployments, PRs, or merges without explicit authorization and verified targets.
- Never claim a feature complete because a route renders, typechecks, or passes a static contract test. Record browser-tested, database-tested, and untested boundaries separately.

## 8. Planning and delivery method

Use one small, coherent batch at a time:

1. Inspect the current branch, working tree, relevant handoffs, routes, migrations, RPCs, and tests.
2. Write a focused gap table: current behavior, reference behavior, proposed scope, data impact, security impact, and acceptance tests.
3. If the batch needs a new cross-module architecture, produce and approve the design before coding.
4. Implement by extending existing systems.
5. Add focused regression tests.
6. For database changes, test both a fresh PostgreSQL 16 apply and a populated upgrade, including RLS/role checks.
7. Run focused tests, web typecheck, lint, production build, and the appropriate combined gates.
8. Perform browser QC with owner and restricted roles where the feature is user-facing.
9. Write an honest handoff with branch/SHA, files changed, raw results, browser coverage, deferred risks, and the next smallest safe task.

Recommended sequence:

1. Repository/current-state reconciliation and production login QC.
2. Customer code, CRM bulk edit, Customer 360, and pet editing.
3. Business configuration and personal preferences.
4. Dynamic size-band completion and end-to-end verification.
5. Finance export, audit review, and read-only reconciliation.
6. Backup/restore, access QC, storage accounting, and reliability/recovery.
7. Dashboard analytics and any approved communication-center scope.

## 9. Authoritative references

Read these before planning related work:

- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`
- `docs/HOMEPAW_PARITY_PLAN.md`
- `docs/handoffs/INTEGRATION-HANDOFF.md`
- `docs/handoffs/PLATFORM-ACCESS-QC-HANDOFF.md`
- `docs/handoffs/HOMEPAW-CATALOG-SIZE-HANDOFF.md`
- `docs/handoffs/HOMEPAW-REGISTRATION-USAGE-HANDOFF.md`
- `docs/handoffs/S23-S26-HANDOFF.md`
- `docs/handoffs/S27-S30-HANDOFF.md`
- `docs/handoffs/ENGINE-3-S32-S33-HANDOFF.md`
- `docs/handoffs/S35-HANDOFF.md`
- `docs/handoffs/DEEPSEEK_HOMEPAW_PARITY_CONTINUATION.md`
- `OPERRO-NEW-CHAT-HANDOFF.md`

The supplied HomePaw reference files recorded in the handoff are external product references, not repository source. Do not upload credentials, `.env` files, authentication tokens, production keys, database dumps containing personal data, or raw user data to a planning service.

## 10. Current local-state warning

At this snapshot, the tracked branch is aligned with `origin/feat/platform-org-access-qc`, but the working tree already contains untracked context/outsourcing material. Preserve it and do not accidentally include it in a product commit without review:

- `OPERRO-NEW-CHAT-HANDOFF.md`
- `deepseek-outsourcing/`
- `docs/handoffs/DEEPSEEK_HOMEPAW_PARITY_CONTINUATION.md`
- This context document.

