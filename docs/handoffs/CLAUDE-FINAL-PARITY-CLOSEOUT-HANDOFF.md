# Claude final parity closeout handoff

Date: 12 October 2026 (Asia/Jakarta). Brief: `CLAUDE-FINAL-PARITY-CLOSEOUT-20261012.md`. Baseline: commit `33fcad3` content.

**Local work only.** Nothing was committed to the repository under review, pushed, deployed, merged or applied to any hosted Supabase, Vercel or WhatsApp environment. No credential or secret was read, no provider was contacted, and no real user, invitation, invoice, e-mail or message was created. Browser checks used a private local Supabase CLI stack (own project id, ports 55321/55322) with synthetic accounts, a local-only test password and a Next dev server on `127.0.0.1:3100`. **No hosted staging, real Storage bucket, WhatsApp provider or mail test occurred.** Local Storage in the browser pass was the Supabase CLI's own storage container.

**Verdict in one line: all eight streams moved forward and every delivered part is locally proven; none is declared fully at HomePaw parity.** Each section ends with what is implemented, what is still partial and which owner decision remains. The parity proposal and the release sequence are in separate files:

- [docs/HOMEPAW_PARITY_AUDIT_PROPOSAL_2026-10-12.md](../HOMEPAW_PARITY_AUDIT_PROPOSAL_2026-10-12.md)
- [docs/RELEASE_SEQUENCE_FINAL_PARITY_CLOSEOUT.md](../RELEASE_SEQUENCE_FINAL_PARITY_CLOSEOUT.md)

## 0. Baseline and method

- The supplied snapshot has no `.git` directory. A local baseline repository was created from the snapshot content as commit `8715894`; it stands in for `33fcad3`. Every edit sits on top of it and the patch is `git diff` against it. The real history of `33fcad3` was not available to me. See [baseline-git.txt](logs/FINAL-PARITY-CLOSEOUT/baseline-git.txt): clean tree before any edit.
- Read first: `apps/web/AGENTS.md` (Next.js 16.3.6: `params`/`searchParams` are Promises, Turbopack), the 1 October parity audit and the three handoffs named in the brief.
- Baseline web suite before any edit: 642 tests, 0 failures ([baseline-web-tests.log](logs/FINAL-PARITY-CLOSEOUT/baseline-web-tests.log)).
- Work order followed the brief: P1 to P8, one forward-only migration per independently deployable slice, `20261031100000` to `20261031160000`. No existing migration was edited. Several existing tests and one existing probe were adjusted where they pinned a value that a new migration legitimately changes (listed in section 9).

## 1. Design table (written before implementation)

| Stream | HomePaw behavior | Accepted Operro baseline | Bounded behavior built | Schema / RPC impact | Permission model | Migration | Cannot be proven locally |
|---|---|---|---|---|---|---|---|
| P1 #1 dashboard | Period stats, sources with revenue/LTV, "alerts" for membership expiry and unpaid items | `app.performance_dashboard` aggregates (operations, finance, sources), card visibility settings, Jakarta periods | Five count-based alerts over existing records with fixed thresholds, one link each; one optional card key | `app.dashboard_operational_alerts(text[])`, `update_dashboard_card_settings` replaced (optional key), two partial indexes | Per-alert capability + module + branch set; a requested alert the caller may not read raises 42501; a denied alert issues no query | `20261031100000` | Real-size query timing on hosted data; owner judgement on the thresholds |
| P2 #31 finance | "Modal" (capital) and "Kas tersedia" (cash on hand) | `finance_cash_position` (read-only), payment register, expenses/refunds, payment-register XLSX | Cash-control register: accounts and immutable declared movements, reversal-only corrections, per-account per-currency position, source links as references; finance export gains register sheets | `cash_accounts`, `cash_movements`, 5 RPCs, immutability trigger | `finance.read` to read, `finance.manage` to write, branch grant; organization-wide accounts need `branches.all` | `20261031110000` | Truthful cash on hand (payment-to-account mapping, payroll payout recording, bank reconciliation) is an accounting decision |
| P3 #34 WhatsApp | Batch center and per-message log, manual `wa.me` sending | `whatsapp_drafts` with status contract, opt-out, per-source capabilities | Batch of up to 25 sources: preview, eligibility, dedupe, create, cancel; append-only event log; user-reported outcomes; batch history | `whatsapp_batches`, `whatsapp_drafts.batch_id`, `whatsapp_draft_events`, resolver + 3 batch RPCs, `create_whatsapp_draft` re-created | Existing per-source capability + crm module; clients get SELECT only | `20261031120000` | Anything about delivery or read state: needs an official provider, credentials, consent and webhook decisions |
| P4 #38 export | Whole-workspace JSON export | Bounded JSONL archive, manifest with SHA-256, verifier, per-file Storage metadata | Reviewed 17-table allowlist extension, `org_export_scope`, retention and purge, recorded verification, offline dry-run restore-readiness planner, restore-drill runbook and evidence template | `org_export_scope`, purge candidates/mark, `org_export_record_verification`, list/manifest replaced, Storage delete policy | Business owner only | `20261031130000` | An actual restore. No importer exists and none was built |
| P5 #39 business config | One configuration object (hours, labels, templates, thresholds, due day, ...) | Most keys already have typed homes (documents, follow-ups, storage, dashboard, catalog, payroll, preferences) | A mapping table on screen and one new typed write path: branch calendar hours | `app.set_branch_calendar_hours` | Business owner, or `branches.manage` with access to that branch | `20261031140000` | Owner decision on `sourceLabels`, `dueDayDefault` (not mapped) |
| P6 #41 accounts | Role/owner switching | Platform invitations, claim RPC, Admin checklist, platform-owner switching | SQL role tests for claim, suspended workspace, wrong/unverified e-mail, expired/revoked/used links, Admin denial; truthful claim error messages; a staging QC script | No schema change; 57-assertion SQL test; `describeInvitationError` | Unchanged | none (test `20261031145000`) | Real mail delivery, real invitation click-through on a hosted project |
| P7 #43 storage | Storage usage and cleanup | Dry-run-first cleanup with lease, per-object retry, abandon | A per-organization consent record that is off by default, instantly revocable and audited; operator runbook. No scheduler | `storage_cleanup_schedules`, `set_storage_cleanup_schedule`, `storage_cleanup_schedule_state` | Business owner | `20261031150000` | An unattended run: the repository has no scheduler or service identity |
| P8 #44 reliability | Basic safeguards | `/settings/health`, `health_summary`, recovery readiness doc | Archive freshness/verification/purge and cleanup-consent signals tied to owner actions; restore drill checklist and evidence format | `health_summary` extended | Business owner; platform section unchanged | `20261031160000` | Provider backup status, point-in-time recovery, a recorded restore drill |

## P1 Dashboard analytics and operational alerts (#1)

**Delivered.** An "Peringatan operasional" panel on `/dashboard`, controlled by a new optional card key `operational_alerts` (organization-owned, same settings object as the other cards). Five alerts, each stating what it measures and linking to exactly one page the same capability already opens:

| Alert | Source and fixed threshold | Needs | Link |
|---|---|---|---|
| Unbilled completed visits | `app.reconcile_unbilled_visits` (existing invoker RPC), whole history, counted up to 100 | booking.read, finance.read, order.read | `/reconciliation` |
| Overdue invoices | status issued, `due_at` passed, total exceeds succeeded payments; count, remaining amount and oldest due date **per currency** | finance.read | `/finance` |
| Packages expiring | active, sessions remaining, `expires_at` within 7 days | membership.read | `/programs/memberships` |
| Open bookings never closed | requested/confirmed/in progress, started more than 24 h ago, 90-day look-back | booking.read (not a Groomer-role member) | `/schedule` |
| Maintenance problems | export or cleanup run failed/partial/abandoned in 30 days, or running past 2 h / its lease | business owner | `/settings/health` |

Double-booked resources are deliberately not an alert (an EXCLUDE constraint makes them impossible).

**ROI is not built.** There is no tenant-owned, auditable marketing-spend model in the baseline, and attribution would be a guess. Source performance remains as accepted (new customers, revenue, LTV per source); the panel states that ROI is unavailable. HomePaw's "Source ROI" is revenue/LTV per source, which the dashboard already shows under its correct name.

**HomePaw comparison.** Alerts for expiring membership and unpaid items exist. Spend-based ROI is absent on purpose. Period comparison and per-source figures were accepted before this work.

**Migration** `20261031100000_dashboard_operational_alerts.sql`: `app.dashboard_operational_alerts(p_keys text[])` (SECURITY DEFINER, `search_path = ''`, branch set resolved once for speed like the accepted dashboard aggregates, organization only from the session, every table read states `organization_id`), `update_dashboard_card_settings` replaced (optional key independent of the three all-or-none performance keys; omitted optional keys keep their stored value), partial indexes on bookings and customer packages. Execute revoked from `public`/`anon`, granted to `authenticated`.

**Authorization.** A requested key the caller may not read raises 42501 instead of returning a zero. In the web layer `buildAlertReadPlan` decides which alerts may load; a false entry issues **no** query, which preserves the accepted "denied cards make no underlying query" rule. One failing alert never hides the others.

**Tests.** SQL `20261031100000_test_dashboard_operational_alerts.sql`: 38 PASS (thresholds, per-currency amounts, branch restriction, cross-tenant, denied key, Jakarta boundary, anon). Web `dashboard-alerts.test.tsx` (10 tests: plan per capability, no query when denied, partial failure, empty state, link targets). The existing performance-dashboard SQL test stays green (54 PASS); its schema_version assertion was loosened to a shape check because the version now moves with later migrations.

**Browser (local stack, owner session).** The seed was built to trigger the overdue, expiring and stale alerts and the owner dashboard was checked on it earlier in this session; I did not re-open the dashboard after the final test run. Not checked: a 375 px layout, and a restricted-role dashboard view in the browser (denial is covered by the SQL and web tests).

**Limitations.** Thresholds are fixed constants, not owner-tunable. Alert counts for unbilled visits cap at 100. Packages are not branch-scoped in the table, so that alert is not either.

**Status: partial.** Analytics and alerts are delivered. Source ROI needs an owner-approved spend model (who records spend, per source, per period, per branch?) before it can exist.

## P2 Financial operations (#31)

**Delivered.** `/finance/register` ("Register kas"): cash, bank or e-wallet accounts and **immutable** movements a person declares: opening balance, capital contribution, owner withdrawal, other cash in, other cash out. A movement has one account, one currency, one calendar day and may reference an existing expense, payment or refund. A mistake is corrected only by a reversal entry; rows are never updated or deleted (a trigger refuses it even for the table owner). The position is the sum of an account's own movements, per account and per currency, shown beside the existing read-only cash position and never netted with it. The finance XLSX export gains the register accounts with positions and every movement; each sheet is formula-safe and bounded (payments 19,900 rows, every other table 50,000, failing loudly beyond that, never silently truncating or mixing currencies).

**This is a cash-control register, not a ledger.** Payments, refunds, expenses and payroll payouts do **not** post into it. A link is a reference, not a posting. The screen says so, and nothing is called profit, tax or accounting. HomePaw's "Kas tersedia" (capital minus expenses minus salaries paid) would need the owner's decisions on payment-to-account mapping, payroll payout recording and bank-statement reconciliation. Those decisions are **not** taken here.

**Migration** `20261031110000_cash_control_register.sql`: tables `cash_accounts`, `cash_movements`; RPCs `create_cash_account`, `set_cash_account_archived`, `record_cash_movement`, `reverse_cash_movement`, `cash_register_position`; immutability trigger. Clients have SELECT only; every write is an RPC; the existing audit trigger records changes. Idempotency by request key.

**Authorization.** Read: `finance.read` + finance module + the account's branch. Write: `finance.manage` (the owner holds it; may delegate to Admin). An organization-wide account (no branch) can only be created or posted to with `branches.all`. `finance.manage`, `order.read` and `branches.manage` were added to the web capability map.

**Tests.** SQL 101 PASS (immutability including as table owner, reversal rules, double reversal refused, per-currency separation, branch isolation, cross-tenant, direct DML denied, anon, idempotent replay). Web `cash-register.test.tsx` (10) and the extended `finance-cash.test.ts`.

**Browser.** `/finance/register` was exercised as the owner on the local stack. A restricted role was not separately re-checked in the browser; denial is covered by the SQL and web tests.

**Status: partial.** The register is real and safe. A truthful cash-on-hand figure remains an accounting decision.

## P3 WhatsApp operations (#34)

**Delivered.** `/whatsapp/batches` and `/whatsapp/batches/[batchId]`. Choose a source (invoice, follow-up, renewal), select up to 25 eligible items, preview (saves nothing), then create the batch of drafts. A person opens each draft in WhatsApp themselves and **reports** the outcome (opened, marked sent, marked failed, retry, cancel). An append-only event log records every creation and status change (who, when, from, to, note, batch). Customers who opted out, are archived, have no number or already have an active draft are skipped, with the reason shown. Batch history is paged; a batch can be cancelled.

**What it does not do.** Operro sends nothing. The statuses are user reports, not delivery or read confirmation, and the screen says so; there is no unofficial sending or scraping. Registration invitation links cannot be batched because their one-time link is never stored. No provider adapter was built; enabling an official one needs the provider, credentials, customer consent, webhook endpoint and staging decisions.

**Migration** `20261031120000_whatsapp_batch_log.sql`: `whatsapp_batches`, `whatsapp_drafts.batch_id`, `whatsapp_draft_events` (append-only, written by a trigger so single-draft actions, batch actions and the opt-out cancellation are logged identically), `whatsapp_resolve_recipient` (the one eligibility rule), `preview_whatsapp_batch`, `create_whatsapp_batch`, `cancel_whatsapp_batch`; `create_whatsapp_draft` re-created to delegate to the shared rule with the same inputs, errors and result.

**Authorization.** The existing per-source capability plus the crm module; the organization comes from the session; clients get SELECT only.

**Tests.** SQL 83 PASS (eligibility each reason, dedupe, 25 cap, status transitions, append-only, cross-tenant, capability per source, anon, retry visible in the log). Web `whatsapp-batches.test.tsx` (9) and the extended `whatsapp-drafts.test.ts` (message builder shared with the single-draft action).

**Browser.** Owner session: batch creation, cancel and history on seeded invoices (the history row shows the owner's cancelled batch). Admin session: the page renders with the same notice and the eligible-source list. Not checked: opening a real `wa.me` link (no message was or will be sent from this environment).

**Status: partial.** A manual batch workflow with an auditable log is implemented. Provider delivery status stays absent by design.

## P4 Organization export, restore readiness and ownership (#38)

**Delivered.**

1. **Transparent scope.** `app.org_export_scope()` (business owner) lists every allowlisted table with its live count and every other tenant table with a reason it is not archived (secrets, access control, operator data, bookkeeping, sensitive, configuration-only, no uuid cursor, not yet reviewed). A deterministic fingerprint of table names tells a reader whether two archives share a scope. The allowlist grew by 17 reviewed tables; coverage is now 59 tables plus workspace configuration plus Storage object **metadata**, and 38 other tenant tables are listed with reasons. New tenant tables stay out of the archive until a migration lists them.
2. **Retention.** A failed or cancelled archive older than 7 days and a completed archive older than 90 days (never the newest completed one) are purge candidates. The owner removes the files through Storage (new owner-only delete policy on the archive prefix) and records it with `org_export_mark_purged`; the job row and manifest remain as history; a purged archive can no longer be verified or downloaded.
3. **Recorded verification.** After the application runs the metadata verifier it records when and whether it passed (`org_export_record_verification`). This is the application's record, not an independent attestation.
4. **Restore-readiness planner (offline, dry run only).** `apps/web/scripts/verify-org-export.ts` plus `lib/org-export-restore-plan.ts` read a downloaded archive, verify hashes and counts, reject unknown or unsafe input, and print a load order for an empty disposable target (foreign-key cycles are appended and flagged, append-only tables are flagged INSERT-only). Exit code 0 ready, 1 not ready, 2 usage. It never connects to a database and writes nothing. Run on a real archive exported through local Storage: [restore-readiness-local-archive.txt](logs/FINAL-PARITY-CLOSEOUT/restore-readiness-local-archive.txt) (59 tables, 51 rows, 13 append-only tables, "not a restore and not a recovery claim").
5. **Runbooks.** `docs/runbooks/DISPOSABLE_RESTORE_DRILL.md`, `RESTORE_DRILL_EVIDENCE_TEMPLATE.md`, `restore-schema-probe.sql`; `RECOVERY_READINESS.md` links them.

**This is still an export archive, not a backup.** It never contains Storage object bodies, Auth identities, token hashes, provider credentials or signed URLs. **No importer was built and no restore was performed**; no restore drill has been recorded as having happened.

**Migration** `20261031130000_export_scope_retention.sql`. The scope function classifies `storage_cleanup_schedules` (added by P7) as bookkeeping.

**Authorization.** Business owner only for scope, purge and verification; Storage delete is restricted to the owner's own archive prefix.

**Tests.** SQL 64 PASS (scope classes, allowlist re-review of column names, retention rules incl. "never the newest completed", purge ownership and cross-tenant refusal, verification record, direct DML denied, anon). The existing org-export SQL test was updated (function count 18) and stays at 6 PASS. Web `org-export-scope.test.tsx` (10), `org-export-restore-plan.test.ts` (10), and the extended `org-export-contract.test.ts`.

**Browser and Storage (local stack).** Owner: exported an archive to the local Supabase Storage container, verified it, started a second export, and ran the retention purge with files past retention actually removed from local Storage. The planner was run against the downloaded archive. This is the Supabase CLI's Storage, not a hosted bucket.

**Status: partial.** Scope, retention, verification and a dry-run planner are real. The remaining gap is a recorded disposable-project restore drill and an importer, which is an owner decision about how far to go.

## P5 Business configuration (#39)

**Delivered.** `/settings/business` ("Pengaturan bisnis", in the navigation) with two parts.

1. **Settings map.** Every key HomePaw keeps in its single configuration object is listed with its scope (organization, branch, personal, platform), where Operro holds it, who may change it and a link to that page. Most keys already had a typed home.
2. **Calendar hours per branch.** The one setting that Operro read (`branches.settings.schedule.dayStartMinutes/dayEndMinutes`) but could not write. A typed form per branch: quarter-hour steps, minimum two hours, optimistic concurrency on the branch's `updated_at` (a second editor is refused and asked to reload), sibling settings preserved, audit through the existing branch trigger. Hours only size the displayed axis; bookings outside them still show and availability and slot recommendations are untouched.

**Not mapped, listed on screen as such:** `sourceLabels` (Operro stores source as free text and the dashboard normalizes it; a closed list is a new feature), `dueDayDefault` (due date is chosen per invoice; an organization default is a new feature), organization currency (cannot be changed once invoices and payroll exist). Billing plan and quota are platform settings, not business settings. There is no generic settings editor.

**Migration** `20261031140000_business_settings.sql`: `app.set_branch_calendar_hours`.

**Authorization.** Business owner, or a member with `branches.manage` who can access that branch. **Finding, not changed:** `authenticated` still has a direct UPDATE grant on `branches` governed by an existing policy; that is baseline behavior and outside this change.

**Tests.** SQL 29 PASS (bounds, step, span, concurrency conflict, sibling keys preserved, branch scoping, delegated capability, cross-tenant, anon). Web `business-settings.test.tsx` (7).

**Browser.** As owner and Admin, `/settings/business` renders the map and one form per branch; saving 07:00 to 19:00 on the first branch worked.

**Status: partial, narrowly.** All mapped settings have an authoritative home. Three HomePaw keys remain unmapped pending an owner decision on whether to adopt them as new features.

## P6 Accounts and permissions live-readiness (#41)

**Delivered.** No schema change. A 57-assertion PostgreSQL role test for the invitation claim and its refusals, truthful claim error messages, and a hosted-staging QC script.

- SQL `20261031145000_test_invitation_claim.sql`: only the SHA-256 of the token is stored under a normalized e-mail and the plain token appears nowhere; seven-day life; unknown role, platform role, malformed or overlong e-mail and unknown organization refused; a business owner cannot issue invitations; tenant Admin cannot list or issue; anon cannot issue or claim; reissue revokes the older link; no invitation for a suspended workspace; a link for a workspace suspended after issuing cannot be claimed and creates no membership; wrong or unverified e-mail refused with no membership created; deactivated user refused; used, expired and revoked links unavailable; malformed tokens refused (including an injection string); multi-organization claim keeps both memberships and switches the active one; a suspended member cannot be reactivated by an old link; an Admin invitation never makes an owner or grants roles/users management; a Pemilik invitation never makes a platform owner; a Groomer invitation has no finance or payroll access; anon has no execute; clients cannot touch the invitation table; exactly six legitimate claims succeeded.
- Web: `describeInvitationError` separates actionable cases (wrong or unverified e-mail, already a member, workspace not active, link used/expired/revoked, service not ready) from a transient failure, which is no longer reported as "the link is invalid". Tests `access-readiness.test.ts` (4) and the extended `control-plane-ui.test.tsx`.
- `docs/runbooks/STAGING_ACCESS_QC.md`: the manual script for the real invitation and multi-organization flow on a hosted staging project.

**Browser (local stack, synthetic accounts).** Signed in as a restricted helper and tried to accept someone else's invitation: refused with "Masuk menggunakan email penerima undangan yang sudah diverifikasi." and the API returned 403. Then signed in as the intended recipient through the accept form: claim succeeded (200) and landed on the dashboard of the invited workspace as Admin. As that tenant Admin, `/settings/health` shows "Hanya untuk pemilik" (restricted access, not an empty state). Platform-owner workspace switching and suspended-workspace claim were proven in SQL, not clicked in the browser. The 403 in the console is the intentional wrong-user refusal.

**Limitations.** No real invitation e-mail was sent or received; no hosted project was used.

**Status: partial.** Local role and RLS proof is in place. Live readiness needs the owner to run `STAGING_ACCESS_QC.md` on a hosted staging project.

## P7 Storage and maintenance automation (#43)

**Delivered: the disabled state only.** This repository has no scheduler and no service identity (no cron route, no `vercel.json` crons, no pg_cron job, no service-role client), and the cleanup RPCs act only inside a business owner's own session. An unattended runner therefore needs two platform decisions that are not taken: which scheduler, and how it authenticates and is limited to an organization that opted in. Nothing here pretends to run.

What exists: a per-organization consent record on `/settings/storage`, **off by default**, switchable off instantly by the owner and audited. A future runner must read it and must still respect the existing lease, dry-run-first rule, per-object retry and abandon logic. The screen states plainly that turning consent on deletes nothing and that no runner exists. `docs/runbooks/UNATTENDED_CLEANUP.md` is the operator runbook with the decisions needed. No provider quota is shown as a billing fact and no per-organization database bytes were invented.

**Migration** `20261031150000_cleanup_schedule_consent.sql`: `storage_cleanup_schedules`, `set_storage_cleanup_schedule`, `storage_cleanup_schedule_state`.

**Authorization.** Business owner only.

**Tests.** SQL 25 PASS (default off, owner only, instant disable, audit row, cross-tenant, direct DML denied, anon). Web `cleanup-schedule.test.tsx` (5).

**Browser.** Owner recorded consent on `/settings/storage` on the local stack; the panel states that no runner exists. Real cleanup behavior against Storage remains covered by the accepted E3 suite, separately.

**Status: partial.** Consent foundation and runbook only. Unattended cleanup needs the owner's scheduler and service-identity decision.

## P8 Reliability and recovery proof (#44)

**Delivered.** `app.health_summary()` gains only signals backed by real records of the organization: completed archives whose files still exist, newest completed time, archives never verified or whose last verification failed, the last recorded verification outcome, purge candidates, and whether cleanup consent is recorded. `/settings/health` turns each into a named owner action through `deriveOwnerActions` (for example verify an archive, purge past retention, review a failed cleanup, run the restore drill). Together with the P1 maintenance alert, unresolved export and cleanup problems now surface on the dashboard and in health.

Nothing is probed or simulated; no provider API is called; no credential, provider log, raw database error or path is returned; the platform-only section and the tenant redaction are unchanged. `EXPECTED_SCHEMA_VERSION` is `20261031160000`, equal to the newest migration, and the drift test enforces that. A restore-drill checklist and evidence format were added in P4 and linked from `RECOVERY_READINESS.md`; a production restore is out of scope.

**Migration** `20261031160000_health_signals.sql`.

**Tests.** SQL 19 PASS (counts per tenant, owner-gated, no other tenant's data, no raw text, anon). Web `health-owner-actions.test.tsx` (8) and the extended `control-plane-ui.test.tsx`.

**Browser.** Owner session on `/settings/health`; tenant Admin sees the restricted-access state. The platform recovery-drill form (platform owner only) was **not** exercised in the browser.

**Status: partial.** Signals and owner actions are real. Provider backup status and any restore proof need a hosted drill.

## 2. Verification (final tree)

Commands and unedited results are in `docs/handoffs/logs/FINAL-PARITY-CLOSEOUT/`:

| Check | Command | Result | Log |
|---|---|---|---|
| Web suite | `npx tsx --test test/*.test.ts test/*.test.tsx` (in `apps/web`) | 715 tests, 715 pass, 0 fail (baseline was 642; 73 are in new files) | [web-all-tests.log](logs/FINAL-PARITY-CLOSEOUT/web-all-tests.log) |
| Typecheck | `npm run typecheck` (web) and `npx tsc -p tsconfig.typecheck.json --noEmit` (root) | both exit 0 | [typecheck-lint.log](logs/FINAL-PARITY-CLOSEOUT/typecheck-lint.log) |
| Lint | `npm run lint -- --max-warnings=0` (web) | exit 0 | same |
| Build | `npm run build` (web) | exit 0, new routes listed | [build.log](logs/FINAL-PARITY-CLOSEOUT/build.log) |
| Whitespace | `git diff --check` | clean after counting CRLF as the repository's line ending (`-c core.whitespace=cr-at-eol`); plain `git diff --check` reports the carriage returns of CRLF files only | n/a |
| DB gates | `run_all_gates.sh` GATE 4 to 8b inside a fresh `postgres:16` container with real `anon`, `authenticated`, `service_role` roles | `ALL GATES PASSED`, exit 0, 1,268 `PASS` notices | [db-gates.log](logs/FINAL-PARITY-CLOSEOUT/db-gates.log) |
| Populated upgrade | `integration/run_populated_upgrade_rehearsal.sh` (docker, HomePaw demo data, then all new migrations, then the new probe) | `POPULATED UPGRADE PASS`; `FINAL CLOSEOUT POPULATED PROBE PASS` | [populated-upgrade.log](logs/FINAL-PARITY-CLOSEOUT/populated-upgrade.log), [populated-upgrade.stdout](logs/FINAL-PARITY-CLOSEOUT/populated-upgrade.stdout) |

Notes on how to read these:

- GATE 1 to 3 of `run_all_gates.sh` (Node and static checks) were run on the host as the web checks above; the database script is `run_all_gates.sh` with only those three gates stripped, so GATE 4 onward is the unmodified text. In the log, `NOTICE: PASS` lines are the per-assertion results; the gate script's own exit status is the pass signal.
- `run_all_gates.sh` now lists the seven new migrations in `EXPECTED_MIGRATIONS`, includes the new test files in GATE 3 and the eight new SQL tests in GATE 4b. The schema-version contract (`EXPECTED_SCHEMA_VERSION` equals the newest migration) was kept honest; no version was falsified.
- The populated rehearsal's new probe `integration/final_closeout_upgrade_probe.sql` snapshots counts before upgrade, then as the real authenticated HomePaw owner compares each new surface (alerts, register, batch log, scope, health) against independently written queries on the populated workspace and checks that immutability still holds on migrated data.
- Intermediate runs failed and were fixed before the final runs (an exact-version assertion in the P1 test, a hard-coded function count in the P4 test, grants and a cross-organization count in the probe, a planner that dropped foreign-key-cycle tables, and a table that was classified "not reviewed"). The logs above are from the final tree only.
- The browser stack used the Supabase CLI's PostgreSQL 17 image; all migrations applied from scratch there. The gate suite ran on PostgreSQL 16. Both are local.

## 3. Browser evidence summary

Local Supabase CLI stack on its own ports, migrations applied from the repository, two seeded synthetic workspaces (Alpha Groom, Beta Salon) and synthetic owner, Admin, restricted helper and other-workspace accounts with a local-only test password. Surfaces visited as owner: `/dashboard`, `/finance/register`, `/whatsapp/batches`, `/settings/storage` (real local Storage export, verify, purge, cleanup consent), `/settings/health`, `/settings/business` (saved calendar hours). Restricted views checked: helper refused on a foreign invitation; Admin denied `/settings/health`; Admin sees `/settings/business` and `/whatsapp/batches`. Observations are my session notes; no screenshots are included in the patch.

Not done: platform recovery-drill form, 375 px responsive pass, an Admin or helper view of every new page, any hosted staging, real Storage, WhatsApp provider or mail test.

## 4. Existing files adjusted because of new migrations

- `supabase/tests/20261030100000_test_performance_dashboard.sql` and `integration/performance_dashboard_upgrade_probe.sql`: schema_version assertion changed from an exact value to a shape check (`^[0-9]{14}$`), because each migration in this series redefines `app.schema_version()`.
- `supabase/tests/20261028100000_test_org_export.sql`: function count 18 after the P4 additions.
- `run_all_gates.sh`, `integration/run_populated_upgrade_rehearsal.sh`: new migrations, tests and probe.
- Web: `authorization.ts`, `dashboard-read-model.ts`, `finance-export.ts`, `health.ts`, `org-export.ts`, `schedule.ts` (export of `readConfiguredHours`), `whatsapp-draft-data.ts`, and the pages and components listed in the file list.

## 5. Risks to review

1. **SECURITY DEFINER aggregates bypass RLS** (P1 alerts, as the accepted dashboard). If branch policies change later, the SQL suites are the guard.
2. **Existing branch UPDATE grant** for `authenticated` (P5) is baseline and was not changed.
3. **Deploy order matters.** The dashboard settings form now posts eight card keys; the web build must not go live before `20261031100000` (see the release sequence).
4. **Immutable tables** (cash movements, WhatsApp events) cannot be corrected except by a new row; there is no admin override by design.
5. **The restore-readiness planner is advice, not proof.** Its load order has never been executed against a target.
6. **Cash-control register can be mistaken for accounting.** The screen says it is not; owner training should repeat that.

## 6. File list

`git diff --name-status` against the baseline is in `deliverables/FILE-LIST-final-parity-closeout.txt` beside the patch. Groups: seven migrations; eight new SQL tests plus three adjusted; `integration/final_closeout_upgrade_probe.sql`; nine new `lib` modules; seven new components; routes `finance/register`, `whatsapp/batches`, `settings/business` and two server-action files; one CLI script; nine new web tests and six edited; five runbooks; this handoff, the parity proposal, the release sequence; logs.
