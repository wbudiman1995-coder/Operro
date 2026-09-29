# Operro combined integration — S23–S35

## Identity and scope

- Isolated checkout: `E:\Claude\operro-integration` (WSL: `/mnt/e/Claude/operro-integration`)
- Branch: `integration/homepaw-s23-s35`
- Base: `f820b6b904cffd9d7a24af7e395b8effc327fc06` (`local/design-adoption`)
- Inputs: S23–S26 plus S35 at `1a296898b3bf2c49b957c8043bad4af28d0b33be`; S27–S30 at `e5210aa1c32baf9494514634cbde2c987bbc1691`; payroll S32–S33 at `ac7498aeb190b2b9bcf74b6fa82260958d7199b9`.
- This is an integration checkout. The engine branches/worktrees are unchanged; no PR, main-branch merge, or deployment has occurred.

## Merge decisions

1. S35 already sells packages through `/invoices/new` and `app.create_package_invoice`. The later `sellPackageAction`/`PackageSaleForm` from S27–S30 duplicated that path and was removed in conflict resolution. Engine 2's `recordPaymentAction` proof/idempotency pipeline and payment-control UI remain; staff record a package invoice's payment from Finance after issuance. Verify this two-step flow live before calling package-sale parity complete.
2. Authorization keys are the union of the branches: `settings.manage`, `payment.manage`, and `payment.validate` remain capability-gated.
3. The migration manifest is a sorted union. The invoice-number suffix forward migration `20261012100000_invoice_number_random_suffix.sql` occurs exactly once; none of the historical applied migration files were edited for that fix.
4. Payroll's conditional container-aware GATE 8 runner was retained, along with all earlier migrations and GATE 6b payroll tests.
5. The checked-in local Supabase config uses the original `operro-m13-local` ports, exposes the `app` schema, enables private Storage, and adds the payroll seed. Any integration-only port override must be restored before commit.
6. The old booking regex test expected TypeScript pricing logic removed when pricing moved into `app._compute_invoice_pricing`. It was replaced with a real PostgreSQL fixture in `integration/invoice_parity_smoke.sql`: a package-covered service costs 0, a second service on the same pet costs 70 after a fixed category discount, and the fixed pool is not spent on the covered line. `run_all_gates.sh` runs this as GATE 7b.

## Verification completed in this combined checkout

- PostgreSQL 16: `run_all_gates.sh` exited 0. The final run passed GATE 1–8, including 6b payroll, 7b invoice/package arithmetic, 7c membership lifecycle, 7d retention, and 7e documents/payments/evidence/visits. Full raw output: `logs/INTEGRATION/run_all_gates.log`.
- Windows final check after code changes: typecheck and lint exit 0; `test:batch1a` 107/107, `test:batch1b` 314/314, `test:booking` 11/11; Next.js 16.3.6 production build exits 0 with 34 generated routes.
- Isolated local Supabase/Auth/Storage stack: owner and groomer sign-ins worked. In a production-mode Next server, 15 owner routes and 4 groomer routes loaded with HTTP 200; the groomer mobile routes had zero horizontal overflow and zero browser page errors (`logs/INTEGRATION/browser-smoke-production.log`). The intermittent `OrganizationsPage` Performance API error appeared only in the *development* server, and did not reproduce in the optimized production server.
- Real package-sale browser path: issued package invoice `PKG-20260928-1C1723D8` for Cynthia, recorded its cash payment in Finance, and queried the invoice, line, entitlement, purchase ledger, and payment in Postgres. Each expected record existed; paid total was Rp750,000. This proves the merged two-step sale/payment path rather than the deleted bypass form.
- Payment proof browser path: uploaded a bank-transfer proof on `DEMO-INV-002` and moved it through `awaiting_screenshot` → `screenshot_confirmed` → `bank_validated`.
- Evidence and document browser path: the groomer uploaded before and after images for Mochi, completed the pet; the owner completed the home booking and issued `INV-20260929-7C661EBB`. Its two invoice lines are Basic Grooming Rp175,000 and transport Rp35,000, total Rp210,000. `logs/INTEGRATION/service-invoice-QA.pdf` is the saved A4 print output; visual inspection confirmed customer address, groomer, both line items, bank instructions, and both embedded photo images on one page. The photos are white one-pixel QA fixtures, so they prove attachment rendering rather than photographic quality.
- True two-session payment race: one same-key retry generated one payment; two independent payments serialized. The final QA invoice had 3 rows, Rp801,000 paid on a Rp750,000 total, and Rp51,000 marked overpaid. Full session output: `logs/INTEGRATION/payment-concurrency.log`.
- Populated-upgrade rehearsal: `integration/run_populated_upgrade_rehearsal.sh` applied the 38 migrations through the remote project's current version (`20260924110000`), loaded HomePaw demo data, then applied the 21 remaining migrations on PostgreSQL 16. Organization/customer/pet/booking counts stayed `1,6,7,6`; both audit and payment RPCs remained callable. Raw output: `logs/INTEGRATION/populated-upgrade.log`. This is a representative populated database, not a dump of the remote project.
- Read-only remote project check on `tekgjynseoetoxestweb` (Supabase dashboard project `operro-batch2-final-staging`): current migration `20260924110000`, 2 organizations, 9 customer rows, 33 bookings, 2 Auth users. Six customers have `metadata.demo_seed = homepaw_v1`; the remaining three have no demo marker and names `asd`, `12`, and `winston`. The dashboard showed no scheduled backups. No remote schema or data was changed.
- Authenticated audit RPC was verified read-only on that project, using the HomePaw demo owner's membership in a transaction rolled back at the end. The exact returned row for `app.list_audit_events('customers','d0000000-0000-4000-8000-000000000301',20)` was:

  ```text
  id                                   action  entity_table  entity_id                             occurred_at
  019fc1f8-9e42-7f11-bd79-f039511851bb INSERT  customers     d0000000-0000-4000-8000-000000000301 2026-08-02 10:15:23.90526+00
  ```

- Vercel automatically built a Ready preview for commit `6f9d0c1` at `operro-web-git-integration-f1cbda-wbudiman1995-coders-projects.vercel.app`. Its login page renders. The Vercel project has one `NEXT_PUBLIC_SUPABASE_URL` and one publishable-key variable scoped to both Production and Preview; their values were not revealed, so backend identity was not asserted. The preview has not been used for mutation testing.
- The local stack, dev server, and production-mode QA server were stopped. The temporary `supabase/config.toml` override was restored exactly to its merged branch state.
- Reproducible isolated PG16 gate helper: `integration/run_combined_gates.sh`. It copies the repo to a scratch directory, excludes local environment files, and uses its own disposable PostgreSQL container without touching engine stacks.
- Dependency audit: Next.js and `eslint-config-next` were upgraded from 16.2.12 to 16.3.6 after [critical Next.js advisories](https://github.com/advisories/GHSA-p293-qw3h-jr36) and [the AVIF advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4). Safe `npm audit fix` updates removed remaining high findings. The production audit reports 0 critical/high and 2 moderate findings through `exceljs`/`uuid`; no forced major downgrade was applied.

## Still required before production launch

1. Make a recoverable backup/export of the remote project's current schema and data before its first upgrade. The dashboard currently shows no scheduled backup and the Supabase CLI on this machine has no access token. The representative local upgrade passed, but it is not a backup of the actual 9 customer rows and 33 bookings.
2. Establish a genuinely separate non-production Supabase backend for preview testing, or otherwise make the intended Preview/Production backend mapping explicit. Both Vercel environments currently share the same variable *entries*, and no separate remote QA backend was identified. Do the two-pet booking, invoice/package, renewal, payroll export, visits, and second-organization acceptance run there.
3. Review the integration branch, apply the 21 missing migrations to the intended live Supabase project in order, configure the domain/auth redirect URLs and Storage buckets, then promote the Vercel build and smoke-test the live site. No remote schema, Vercel Production alias, or production data was changed by this integration work.

These are release gates, not an assertion that the already-pushed engine branches need rebuilding. Keep one migration lineage when merging; the shared invoice-suffix migration is present once.
