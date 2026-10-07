# Operro handoff for a new chat — 1 October 2026

Paste this file or its path into a new chat in the Operro project. Treat it as context, not as an instruction to claim unfinished work is done. Inspect the repository and live services before changing or deploying anything.

## What the owner wants

Operro is a **sellable, multi-business SaaS for pet-grooming businesses**, with both **home-service and store** operations. The owner's own business is HomePaw. Reuse the existing HomePaw code, screens, copy, workflows and data model as the reference wherever feasible; do not rebuild working features from scratch or spend Claude credit on broad speculative rewrites. Operro must keep business data isolated, while the platform owner `wbudiman1995@gmail.com` can provision, inspect and manage each business, including invoices, subscriptions and suspension. Each subscribed business owner controls their own staff/Admin permission checklist. A platform support Admin must not see business payroll. The business can ask for more storage; the platform owner reviews and bills manually. Do not expose project-wide Supabase/Vercel usage to business tenants.

The owner specifically wants: multi-pet customer intake, Indonesian address selectors (provinsi, kabupaten/kota, kecamatan) and precise home address/Maps location; public registration with admin amend/approve; calendar-first booking by clicking an empty slot, clear location on the calendar card; groomer schedules, GPS/attendance and photo evidence; editable species, breeds, service categories, dog weight bands, prices and durations; packages/memberships and renewals; per-pet service and add-on invoices, payment review, follow-ups, payroll and exports. Booking, pricing, package balance, invoice and payroll must agree on the same data. Existing financial/audit history must remain intact. Make the site fast enough for practical use.

HomePaw source files supplied by the owner are at:

- `C:\Users\DW_wi\Downloads\index (2).html` — HomePaw owner/admin application.
- `C:\Users\DW_wi\Downloads\groomer (3).html` — groomer experience.
- `C:\Users\DW_wi\Downloads\booking (1).html` — booking experience.
- `C:\Users\DW_wi\Downloads\join (2).html` — registration.
- Earlier screenshots in the conversation show HomePaw service prices, membership tiers, size/weight tiers and default durations. The repository also has starter values and parity documentation.

## Source of truth and environment

- GitHub: `https://github.com/wbudiman1995-coder/Operro`.
- Main working checkout for this handoff: `E:\Claude\operro-integration` (WSL `/mnt/e/Claude/operro-integration`). Use this explicit directory for every command. **Do not overwrite** the separate `E:\Claude\operro-local-dev` checkout or other Claude worktrees.
- Production website: `https://operro-web.vercel.app/`. Vercel project is `operro-web`. Current live behavior must be verified; the code below is not automatically live.
- Linked Supabase project ID in earlier handoffs: `tekgjynseoetoxestweb`. Confirm the current Vercel environment points there before any migration or deployment. Do not reveal credentials or paste service keys into chat.
- Read `E:\Claude\operro-integration\apps\web\AGENTS.md` and follow its Next.js documentation instructions before editing web code.
- Primary architecture and rollout history: `E:\Claude\operro-integration\docs\handoffs\INTEGRATION-HANDOFF.md`.
- Platform access work: `E:\Claude\operro-integration\docs\handoffs\PLATFORM-ACCESS-QC-HANDOFF.md` (its rollout status was written earlier; independently verify what is now applied).
- HomePaw coverage map: `E:\Claude\operro-integration\docs\HOMEPAW_PARITY_AUDIT_2026-10-01.md`. This audit counted **28 implemented, 13 partial, 3 missing** at that point; “implemented” means code/tests existed, not that live owner QC passed. It predates the uncommitted work below.
- Related handoffs: `docs/handoffs/S23-S26-HANDOFF.md`, `S27-S30-HANDOFF.md`, `ENGINE-3-S32-S33-HANDOFF.md`, `S35-HANDOFF.md`, `HOMEPAW-CATALOG-SIZE-HANDOFF.md`, `HOMEPAW-REGISTRATION-USAGE-HANDOFF.md`.

## Current exact working-tree state

As checked on 1 October 2026, `E:\Claude\operro-integration` is on branch **`feat/dynamic-sizes-invoice-lines`**, HEAD **`f16eaf8af69952ffe8f7a51b8ecc53ebf1bec891`** (`Restore Supabase Auth token hook execution`). This branch has **uncommitted edits** in 22 tracked files and three new untracked files. Nothing in these uncommitted edits has been pushed or deployed. Preserve them. `git status --short --branch` is the first command in the new chat.

The uncommitted work addresses the last two acknowledged gaps:

1. **Owner-defined dog size categories**, including XXL: `supabase/migrations/20261023110000_dynamic_dog_size_bands.sql` adds per-business size keys/labels/cutoffs, seeds XS–XL, lets the business owner replace the band set with guards against active package/entitlement breakage, changes pet and package validation, adds `service_catalog.dog_size_pricing` JSONB, and updates booking assembly pricing. Web changes cover Catalog, customer intake, booking, package forms, payroll settings, Customer 360 and matrix displays. The new size editor is `apps/web/src/components/dog-size-boundaries-form.tsx`.
2. **Multiple manual-visit invoice lines**: `supabase/migrations/20261023100000_manual_visit_invoice_lines.sql` adds `app.create_invoice_from_manual_visit_lines`; `apps/web/src/components/invoice-studio.tsx` has add/remove line controls, total preview, and `apps/web/src/app/invoices/actions.ts` calls the new RPC. The older one-line RPC remains for old clients.

`run_all_gates.sh` has both migrations in its expected lineage. `integration/dynamic_sizes_invoice_lines_smoke.sql` is a new focused, rollback-only test. Its latest direct PostgreSQL 16 run **passed** four notices: XXL weight/booking price/duration; safe add/rename/delete/package guard; two invoice lines with total Rp150,000; retry and changed-payload guard. That run used the disposable Docker container `operro-dynamic-qc-pg16` with database `operro_homepaw_qc` and repo mounted at `/workspace`. The PostgreSQL 16 migrations applied cleanly; existing `integration/homepaw_qc_smoke.sql` passed. `npm run typecheck -w apps/web`, `npm run lint -w apps/web`, and `npm run test:booking -w apps/web` (14/14) passed **before the last small UI edits**.

`npm run test:batch1b -w apps/web` had **one failing static contract assertion** expecting fixed XS–XL validation in `apps/web/test/service-size-pricing-contract.test.ts`. That test was just updated to expect dynamic bands, but **has not yet been rerun**. A small UI change also just filtered deleted legacy size fields from the create-service form; it has not been re-typechecked. The full Next build, batch1a, full gate wrapper, live browser click-through, populated-upgrade rehearsal, commit/push, remote migration and Vercel deployment are **outstanding**. Never describe this branch as released.

Potential review points before shipping: complete the service edit form's active-band filtering (it still lists static XS–XL even after a deletion); avoid remounting a new size-key input while typing (the form recently changed React key to row index); ensure price/duration settings for custom size bands survive service edits; check all package eligibility and payroll paths use the stored stable size; check invoice retry fingerprint includes all payload fields that should remain immutable; check selecting a different manual visit rotates the request key; test a populated database with existing packages/appointments; test cross-tenant and lower-role access; confirm generated PDF and Customer 360 show all invoice lines. Wire the new SQL smoke into the appropriate gate before the existing size-membership smoke, because that older smoke mutates a pet in a way that can cause the new band-change guard to reject an unrelated edit. Do not modify old applied migrations; use forward migrations.

The current local branch's migration filenames start `20261023`, although the desktop's date is 1 October 2026 and prior repo migrations go through `20261022`. Preserve chronological lineage and check deployment implications; do not silently rename an applied migration.

## Earlier live issues and product rules to keep in view

- The owner reported the production/preview login for `wbudiman1995@gmail.com` failed with “Tidak dapat masuk saat ini.” HEAD `f16eaf8` is an Auth token-hook repair, but **a signed-in production retest is still necessary**. Do not ask for or publish the password. Check Supabase Auth hook, JWT claims, active organization and deployment environment if login still fails.
- Invitations should give lasting email access until a business owner or Operro platform owner revokes it. Invite claim links may be one-time/short-lived, but membership must not expire just because the claim link does. Invitees should not need a Vercel account or phone verification; Vercel preview protection is distinct from Operro Auth.
- The platform owner must identify each subscribed business owner by email, enter every business for QC and data changes, manage billing and suspension. Business Admin permissions belong in that business's Settings; Admin cannot grant itself access-management authority. The platform owner is above that checklist.
- Public registration submissions should land in the customer onboarding queue for admin amend/approve before joining live CRM. Maps URL should validate immediately, and show a clear red error if invalid. Pet weights entered in kg/g should map to size without showing an internal category to applicants.
- Calendar event cards should show the human owner/customer name and kabupaten/kota, not dog names. The calendar is the primary booking entry surface.
- Workspace file counters count photos/documents. The platform DB-size counter includes database tables, schedules and metadata **across the Supabase project**, not accurate per-business DB use. Supabase/Vercel provider dashboards remain authoritative for quotas.
- Existing `/invoices/new` can invoice completed bookings, manual visits and packages; the owner also needs separate Operro-platform invoices to subscribed business owners. Do not conflate these billing domains. The manual-visit invoice editor in this branch is the unfinished HomePaw-parity improvement.
- A previous owner request found several buttons/links unclear, especially storage. During final QC, click every relevant link and report its destination and whether it works.

## Efficient next-chat instruction

Continue from `E:\Claude\operro-integration` **without starting over**. First inspect `git status`, the uncommitted diff, `AGENTS.md` and the documents above. Finish the two in-progress features (dynamic size categories and multi-line manual-visit invoices), fix any defects, and run focused SQL on disposable PostgreSQL 16 plus typecheck, lint, batch tests and production build. If the full gate wrapper is runnable, run it on an isolated DB/container, never on another worktree's Supabase port. Then do a real local/staging browser pass with owner and restricted roles and a populated-upgrade rehearsal. Preserve an honest list of results and remaining gaps. Commit/push only the finished isolated branch; reconcile and deploy to Supabase/Vercel only after verification, using existing owner authorization and verifying the target. Report exact branch/SHA, migration/deployment status, live URL, and concise owner QC clicks. Do not claim HomePaw parity or a working production login without observing it.

The owner is cost-sensitive and has already spent heavily on Claude. Reuse the existing HomePaw and Operro implementations, make narrow changes, avoid spawning new Claude work or broad four-module prompts, and give evidence rather than “done” claims.
