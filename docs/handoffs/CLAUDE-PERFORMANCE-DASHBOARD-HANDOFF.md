# Claude handoff: decision-ready performance dashboard

Date: 10 October 2026 (Asia/Jakarta). Brief: `docs/agent-work/CLAUDE-PERFORMANCE-DASHBOARD-BUILD-20261010.md`. Local work only: nothing was committed, pushed, deployed, merged or applied to a hosted Supabase/Vercel project; no credentials were read; no service-role key was used; no real account, invoice, payment, invitation or WhatsApp message was created. The patch is the working tree; this file is the handoff. Raw logs: `docs/handoffs/logs/PERFORMANCE-DASHBOARD-BUILD/`.

## 0. Three things Codex must decide or know first

1. **Deliberate deviation from the plan: the three aggregates are `security definer`, not `security invoker`.** Measured on PostgreSQL 16 with a synthetic organization of 200 000 bookings, 120 000 invoices, 72 000 payments and 60 000 customers: `app.has_branch` costs about 0.84 ms per call (1 683 ms for 2 000 calls) and the branch RLS policy evaluates it for every scanned row, so the invoker version took **13.7 s (operations), 44.0 s (finance) and 46.2 s (sources) for a 30-day window, and a 366-day operations call hit a 120 s statement timeout** (`EXPLAIN` of a plain 30-day booking count as `authenticated`: 5 379 rows through the new index, 5 853 ms, all of it the RLS filter). Supabase's authenticated statement timeout is 8 s. The shipped version resolves the caller's branch set once (`branches.all`, else `membership_branch_access`, same rule as `app.has_branch`) and filters every branch-owned table itself: 0.08–0.45 s on a quiet machine, 0.16–1.5 s with a populated-upgrade rehearsal running in parallel (`logs/.../scale-timing.log`). Because a definer bypasses RLS, **tenant and branch filters in these functions are the only barrier**; section 5 lists the proof. A reviewer who insists on invoker would need the aggregates to avoid per-row RLS (not possible) or the RLS helper itself to become cheap (a separate task).
2. **A second Claude session was working in the same tree.** While I was building, another session audited an *earlier snapshot* of my work-in-progress (the invoker version), wrote an "IMPLEMENTATION AUDIT" over this handoff path, and left logs in `docs/handoffs/logs/PERFORMANCE-DASHBOARD/` (22:22–22:31 WIB). Its provenance note says it did not author the code; the code is mine. Its statements about `security invoker` and its verification logs describe the superseded migration (SHA-256 prefix `7c416abb…`) and are **stale**. I preserved its handoff verbatim as `logs/PERFORMANCE-DASHBOARD-BUILD/PARALLEL-SESSION-AUDIT-OF-INVOKER-VERSION.md` and left its log directory untouched; everything below was re-run on the final tree. Its `scripts/build-claude-performance-dashboard-packet.ps1`, `agent-bundles/Operro-Claude-Performance-Dashboard-4902945.zip` and `docs/agent-work/CLAUDE-PERFORMANCE-DASHBOARD-MANIFEST-20261010.txt` appeared during the session and were not touched.
3. **Existing tests/scripts were edited because of the schema-version bump and the new card keys** (list in section 4). Every new migration must move `app.schema_version()`; `health-recovery.test.ts` enforces it for TypeScript, and the old SQL health test had the version hard-coded (now `app.schema_version()` shape check).

## 1. Base and preserved state

- Repo `C:\Users\DW_wi\Documents\ChatGPT\Operro`, branch `codex/parity-orchestration` (tracking `origin/codex/parity-orchestration`), HEAD `4902945 feat(parity): complete remaining HomePaw workstreams` — the accepted baseline named in the brief. Migration slot `20261030100000` was free (newest committed migration `20261029170000`).
- Raw start-of-session commands (run before any edit):

```text
$ git status --short --branch
## codex/parity-orchestration...origin/codex/parity-orchestration
?? agent-bundles/Operro-DeepSeek-Engine-1-Owner-Experience-20261009.zip
?? agent-bundles/Operro-DeepSeek-Engine-2-Operations-20261009.zip
?? agent-bundles/Operro-DeepSeek-Engine-3-Platform-Resilience-20261009.zip
?? deepseek-outsourcing/2026-10-09/
?? docs/agent-work/CLAUDE-DYNAMIC-SIZE-BUNDLE-4.md
?? docs/agent-work/CLAUDE-NEXT-BIG-BUILD-20261009.md
?? docs/agent-work/CLAUDE-PERFORMANCE-DASHBOARD-BUILD-20261010.md
?? docs/agent-work/CLAUDE-REMAINING-NINE-TASKS-20261009.md
?? docs/handoffs/CLAUDE-PERFORMANCE-DASHBOARD-HANDOFF.md        (my earlier design-only handoff on the old base)
?? docs/handoffs/logs/CONTROL-PLANE/
?? docs/handoffs/logs/INTEGRATION/sb06-populated-upgrade.log
?? docs/handoffs/logs/REMAINING-NINE-REVIEW-FIX/
?? docs/handoffs/logs/REMAINING-NINE/
?? scripts/build-deepseek-chat-packets.ps1
$ git log --oneline -12
4902945 feat(parity): complete remaining HomePaw workstreams
45fc289 feat(dashboard): add configurable card visibility
25f150e Add organization export verifier
a2c5fe6 Complete dynamic size band integration
04aecd3 Add agent handoff and bundle artifacts
efebb76 Add scoped dashboard metrics and audit history
fa272fe Add tenant-safe Customer 360 pet editing
95ab4bd Add dynamic size booking and customer adapters
7c7f585 Add dynamic size band management
3063ec3 Add guarded Customer 360 pet editing
5d454fe Add tenant-safe CRM bulk editing
8758cff Add dynamic size band database foundation
$ git diff --stat                                   (empty: no tracked file was modified)
$ git diff -- apps/web supabase integration run_all_gates.sh   (empty)
```

- **Pre-existing dirty files preserved: none tracked.** Every pre-existing untracked entry above (bundles, `deepseek-outsourcing/`, `docs/agent-work/*`, the three log directories, `scripts/build-deepseek-chat-packets.ps1`) was left exactly as found. The prior design-only handoff at this path was mine and is replaced by this one.
- Required reading done: `apps/web/AGENTS.md`; Next.js 16.3.6 docs `01-app/03-api-reference/03-file-conventions/page.md` (`searchParams` is a Promise); the parity audit; the control-plane and remaining-nine handoffs; dashboard loader/read model/actions/page/shell/settings form; `20261028110000_dashboard_card_settings.sql`; commercial-core, scheduling-core, financial-sales, invoice-workflow, payment-control-workflow, visit-register, RLS isolation/capability and active-organization migrations; `finance_cash_position` and `cash-position.ts`; the customer-profile source normalizer.

## 2. Evidence table and metric definitions

Jakarta date source: the business time zone resolved by `app/dashboard/page.tsx` (default branch's zone, or the lowest-sorted granted branch's zone — existing behaviour, not reconciled across mixed-zone grants), passed to `resolveDashboardPeriod` and to the aggregates, which convert local dates with `date::timestamp at time zone p_timezone`.

| Metric | Authoritative records and statuses (where confirmed) | Capability and scope | Decision |
|---|---|---|---|
| Appointments completed / open / canceled / no-show | `bookings.status` check: draft, requested, confirmed, in_progress, completed, canceled, no_show (`20260721000500`); by `starts_at`; `deleted_at is null`; **draft excluded**; open = requested+confirmed+in_progress. No `completed_at` column exists, so "completed in the period" is by start time (stated in the UI). | `booking.read` + `scheduling` module, not a `Groomer`-role member (the groomer RLS policy would silently truncate); branch set resolved once | Safe |
| Manual (off-books) visits | separate table, no status to split on | — | **Excluded**, UI says so |
| New customers by source | `customers.source` is free text (nullable). Bucket = trim, collapse whitespace, case-fold; empty = "Tanpa sumber" (own row, never discarded). `deleted_at is null` and `status <> 'archived'` (lead/active/inactive/archived), by `created_at`. Uses the customer's **current** source. | `customer.read` or `customer.manage`, `crm` module, **`branches.all`** — customers carry no `branch_id`, so a branch-limited viewer cannot get a faithful count; they get "unavailable", never zero | Safe |
| First completed booking by source | customer's earliest `completed`, non-deleted booking over **all history** falls in the period | `booking.read`+`scheduling`; the column is `NULL` ("—") without them | Safe |
| First valid paid invoice by source | customer's earliest `succeeded` payment on a **non-void** invoice (all history, via `invoices.customer_id`) falls in the period; package-purchase payments (no invoice) are not an "invoice payment" and are ignored | `finance.read`+`finance`; `NULL` ("—") without them | Safe; labelled "Pembayaran invoice pertama" |
| Issued invoice total | `invoices.status <> 'void'` (`chk_invoices_status`: issued, paid, void) by `issued_at`, per `currency`; includes zero-total prepaid service reports | `finance.read`+`finance`; branch set | Safe |
| Collections | `payments.status = 'succeeded'` by `paid_at`, per currency — same predicate as `app.finance_cash_position` and `app.fn_invoice_paid_total`; `payment_stage` (screenshot/bank validation) is **not** a validity predicate anywhere in the lineage. Payments on later-voided invoices are still money received; they are counted and flagged by an on-screen count (same convention as the cash-position report) | `finance.read` | Safe |
| Refunds | `refunds.status = 'succeeded'` by `refunded_at`, currency from the refunded payment, reached only through a payment in a visible branch. No application code inserts refunds (only reads), so zeros are expected | `finance.read` | Safe |
| Outstanding invoices (snapshot "now") | `invoices.status = 'issued'` and `total` > succeeded payments on it; zero-due invoices excluded (`app.record_payment` refuses `total = 0`, so they can never be paid); overdue = `due_at < now()`. Not period-bound (UI says so) | `finance.read` | Safe |
| Cash movement | `finance_cash_position` is month-bucketed and includes expenses; it also omits manual billing the old revenue card includes | — | **Excluded** (no second, competing cash number) |
| Profit, ROI, conversion, retention, cash on hand, payroll | no spend table, no balance, no funnel records | — | **Excluded**; the source table states that marketing spend per source is not recorded and ROI is unavailable |

Not reused on purpose: the existing "Pendapatan tercatat" card (`loadDashboardData`) sums payments without a currency filter (`payments.currency` defaults to `'USD'`) and adds manual billing. It is untouched; the new section is labelled as independent of the "today" cards.

## 3. What was built

- **Period contract** — `apps/web/src/lib/dashboard-period.ts`, the single definition. Presets today / 7 / 30 days / this month / last month plus custom inclusive range (`?period=custom&from=&to=`), all as business-zone calendar dates via `zonedDayISO`/`addDaysISO`. Previous range = immediately preceding equal-length range (this month 1–10 Oct is compared with 21–30 Sep). Malformed, inverted, future-only, past-today, over-366-day, unknown preset, array-valued, and too-old (comparison before 2000-01-01) input falls back to *today* with an Indonesian message; no query string keeps today-vs-yesterday. The database re-checks adjacency, equal length, ≤366 days, bounds and a real zone name (`app.dashboard_check_periods`). (The cash-position helper's `> 366` check allows 367 inclusive days; it was not reused.)
- **Migration `supabase/migrations/20261030100000_performance_dashboard.sql`** (forward-only, 398 lines, added to `run_all_gates.sh`):
  1. `create or replace app.update_dashboard_card_settings` (definer, `search_path = ''`, `settings.manage`): the four legacy keys stay mandatory booleans; the three new keys `performance_operations`, `performance_finance`, `performance_sources` arrive **all or none**; unknown keys/non-booleans rejected; a legacy four-key payload preserves stored values of the new keys (absent stays absent = visible); sibling settings preserved. The existing `20261028110000` SQL test passes unmodified.
  2. `app.dashboard_check_periods` (invoker, pure validation) and the three aggregates `app.dashboard_operations_performance`, `app.dashboard_finance_performance`, `app.dashboard_source_performance` — definers, `stable`, `search_path = ''`, `revoke all … from public, anon, authenticated; grant execute … to authenticated`. Organization only from `app.fn_active_organization()`; membership, exact capability and module checks raise `42501`; no table is written; no customer identity, contact, note, proof or file reference is returned; money is per currency; the source output is bounded to ten named sources plus one "other" and one "missing" row per period (≤24 rows).
  3. Six supporting indexes (bookings/invoices/payments/refunds/customers by organization + date, a partial index on open invoices).
  4. `app.schema_version()` → `20261030100000`.
  Data-model impact: indexes only. No table, view, materialized view, cron, ledger or tracking collection.
- **Loader** `apps/web/src/lib/dashboard-performance.ts` + `buildPerformanceReadPlan` (in `dashboard-read-model.ts`): a card that is hidden, or whose capability / branch grant is missing, **issues no call** and yields `hidden` / `restricted`; DB `42501` → `restricted`; missing function (`PGRST202`/`42883`) or any other failure → `unavailable` with a reason — never a number. It sends no organization identifier. Failures are per card.
- **UI** `apps/web/src/components/performance-dashboard.tsx` mounted from `dashboard-shell.tsx`; `dashboard/page.tsx` reads `searchParams` (Promise, per the installed docs). Period links and a bounded GET range form, period and comparison labels, neutral "vs previous" wording, collapsible "Definisi angka", empty/restricted/unavailable states, multi-currency notice, void-payment warning, links only to `/schedule`, `/finance`, `/customers`. `dashboard-settings-form.tsx` and `dashboard/actions.ts` iterate `DASHBOARD_CARD_KEYS`, so the form now sends the complete seven-key allowlist.

## 4. Changed files

Modified (10): `apps/web/src/app/dashboard/page.tsx`, `apps/web/src/components/dashboard-shell.tsx`, `apps/web/src/lib/dashboard-read-model.ts` (seven card keys, `buildPerformanceReadPlan`), `apps/web/src/lib/health.ts` (`EXPECTED_SCHEMA_VERSION`), `apps/web/test/control-plane-ui.test.tsx` (seven checkboxes), `apps/web/test/dashboard-read-model.test.ts` (new defaults; latest migration assertions), `apps/web/test/remaining-nine-ui.test.tsx` (schema-version literal), `integration/run_populated_upgrade_rehearsal.sh` (calls the new probe), `run_all_gates.sh` (migration, SQL test, two TS tests), `supabase/tests/20261029170000_test_health_recovery.sql` (hard-coded `20261029170000` → `app.schema_version()` shape check).
New (8): the migration; `supabase/tests/20261030100000_test_performance_dashboard.sql` (54 `PASS`); `integration/performance_dashboard_upgrade_probe.sql`; `apps/web/src/lib/dashboard-period.ts`; `apps/web/src/lib/dashboard-performance.ts`; `apps/web/src/components/performance-dashboard.tsx`; `apps/web/test/dashboard-period.test.ts` (9 tests); `apps/web/test/dashboard-performance.test.tsx` (18 tests). Plus this handoff and `logs/PERFORMANCE-DASHBOARD-BUILD/`.
Reused: `requireActiveWorkspace`, `loadBranchAccess`, `loadBranchTimezones`, `loadDashboardCardSettings`, the card-visibility RPC and form, `app.has_permission`/`has_membership`/`has_module`/`is_groomer_member`, the timezone helpers, `EmptyState`.

## 5. Controls

- **Tenant:** SQL derives the organization from the session; every table read states `organization_id = v_org` (14 occurrences, asserted). Tests: tenant B sees only tenant B on all three aggregates; a user of tenant A with a forged `active_org_id` of tenant B gets `42501` on all three and on the settings writer; tenant B's settings row is untouched; a soft-deleted membership gets `42501`.
- **Branch:** the branch set is resolved once; five branch filters (operations, issued, collected, refunds-via-payment, outstanding) are asserted present. A branch-limited finance user sees only North rows including refunds and outstanding; a caller with `booking.read` but no branch grant sees zero bookings; the customer-wide source breakdown requires `branches.all`.
- **Capability:** loader (no call) and database (`42501`) both enforce `booking.read`, `finance.read`, `customer.read|manage`, module flags and the `Groomer` exclusion; `anon` cannot execute any function; source columns that need a second capability are `NULL`.
- **Currency:** every money figure is grouped by `currency`; the UI never adds across currencies.
- **Bounding:** ≤366 days × two windows; indexed date predicates; first-event checks run only for candidates inside the two windows via index lookups (no per-customer round trips); no full customer scan; ≤24 source rows. Measured on the synthetic scale fixture above (0.08–0.45 s quiet, 0.16–1.5 s under parallel load); this is one machine, one data shape, not a production benchmark.

## 6. Verification actually run (final tree; raw logs in `logs/PERFORMANCE-DASHBOARD-BUILD/`)

| Check | Command | Result |
|---|---|---|
| Full web suite | `npx tsx --test test/*.test.ts test/*.test.tsx` (apps/web) | `tests 642 / pass 642 / fail 0 / cancelled 0 / skipped 0` (615 before; +27 new) (`web-all-tests.log`) |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint, zero warnings | `npm run lint -- --max-warnings=0` | exit 0 |
| Production build | `npm run build` | `✓ Compiled successfully`, exit 0, `/dashboard` listed |
| Whitespace | `git diff --check`; trailing-whitespace scan of the new files | exit 0 / none (only the LF→CRLF notices of this tree's autocrlf) |
| New SQL suite, fresh PG16 | `psql -v ON_ERROR_STOP=1 -f supabase/tests/20261030100000_test_performance_dashboard.sql` on a clone of a fully migrated `postgres:16` database | **54 `NOTICE: PASS`, 0 FAIL** (`performance-sql-test.log`) |
| Same suite on Supabase's own image | same file via `docker exec` into the local Supabase CLI database (PostgreSQL 17.6, real Supabase migrations and default grants) | **54 PASS, 0 FAIL** (`performance-sql-test-supabase-pg17.log`) |
| Whole repository DB gates | `run_all_gates.sh` GATE 4 → 8b in a `postgres:16` container against a copy of the repo (GATE 1–3 are the Node checks above) | `ALL GATES PASSED`, `GATES_EXIT=0`, 864 `PASS` lines, no FAIL (`db-gates.log`); includes the unchanged `20261028110000` card-settings test and the edited health test |
| Populated-upgrade rehearsal | `integration/run_populated_upgrade_rehearsal.sh` run from a copy of the repo in WSL (own disposable container; the committed `INTEGRATION/populated-upgrade.log` was not overwritten) | `REMAINING NINE POPULATED PROBE PASS`, `PERFORMANCE DASHBOARD POPULATED PROBE PASS` (aggregates equal independent queries on the HomePaw workspace in 0.125 s), `POPULATED UPGRADE PASS`, exit 0 (`populated-upgrade.log`, `.stdout`) |
| Mutation sensitivity | 21 single-fault edits of the migration, each applied to a clone and run against the SQL suite (`mutation-checks.log`) | **20 of 21 detected.** The survivor removes `app.has_membership()` from the source function only: `app.has_permission` already requires a live membership, so it is an equivalent mutant (a separate soft-deleted-membership test covers the behaviour). Faults covered include pending/failed counted, void invoices, archived customers, `branches.all`, `booking.read`/`finance.read`, failed refunds, adjacency, void first-payment, first-completed history, legacy-key preservation, Groomer exclusion, zero-due, UTC boundary, 366-day cap, NULL columns, dropped organization / branch / payment-organization filters |
| Scale | synthetic organization (200 000 bookings, 120 000 invoices, 72 000 payments, 60 000 customers) on PG16, aggregates as `authenticated` | invoker shape: 13.7 / 44.0 / 46.2 s (30 days), >120 s (366 days); shipped definer shape: 0.08–0.45 s, or 0.16–1.5 s under parallel load (`scale-timing.log`) |

Honest limits of the evidence: bare PG16 lacks Supabase's default table grants (the PG17 run above uses the real ones); the static source test in `dashboard-performance.test.tsx` is **not** an RLS test — the behavioural proof is the SQL suite; the synthetic scale run seeded rows with triggers disabled and is not production data.

## 7. Browser-tested versus not tested

Tested in a real browser (Browser pane) against a **private local Supabase CLI stack** started from this repo's migrations, with test accounts created through the local sign-up endpoint (no service-role key, no real account); full notes in `browser-pass.md`. Covered: owner full dashboard with figures identical to the SQL test's expectations; default and preset periods; custom range through the form; exactly-366-day range accepted and 367 refused with the message; empty period; branch-limited finance role (South rows absent); customers-only role (operations and finance unavailable with reasons, no money, "—" columns); card-visibility save (complete seven-key allowlist stored) and its effect after reload; 375 px width (no horizontal overflow from the new section; screenshots reviewed); no console errors. Not covered: a hosted staging project and real PostgREST exposure there, other browsers, keyboard-only and screen-reader use. One dev-server observation (settings `POST` taking 24–43 s while the pane was hidden although the RPC answers in 0.09 s) is recorded in `browser-pass.md`; not reproduced with a displayed pane. The local stack, dev server, `.env.local` and the temporary `launch.json` entry were removed afterwards.

## 8. Deliberately excluded

Profit, ROI or cost per source (no attributable spend exists), conversion, retention, cash on hand, payroll figures, manual-visit counts, expenses and the month-bucketed cash-position report, drill-down to individual customers, exports, saved/custom reports, source history, and any change to the existing "today" cards or their revenue arithmetic.

## 9. Unresolved risks and the next smallest safe task

1. **Definer bypasses RLS.** If the bookings/invoices/payments RLS or `app.has_branch` semantics change later, the aggregates will not follow automatically; the SQL suite and the static filter-count assertions are the guard.
2. **Source attribution drifts with edits** (current free-text field; documented in the UI) and the display label is the alphabetically-first spelling seen in the period rows (the fixture's "Instagram/instagram/INSTAGRAM" shows as "instagram").
3. **Branch-limited viewers get no source breakdown** (customers have no branch) — correct but may want a product decision.
4. Collections include payments on later-voided invoices (consistent with the cash-position report); the warning count is shown, cleanup belongs in Finance/reconciliation.
5. The existing "Pendapatan tercatat" card still ignores currency; refunds will read zero until a workflow inserts them; `payments.currency` defaults to `'USD'`.
6. Two writers in one tree happened once this session; re-check mtimes before trusting any handoff in `docs/handoffs/logs/PERFORMANCE-DASHBOARD/`.
7. Deploy order: apply the migration **before** the web build (the settings form now posts seven keys; an old database rejects them with `22023`; an old database without the aggregates degrades each card to "unavailable").

**Next smallest safe task:** Codex review of `20261030100000_performance_dashboard.sql` (especially the definer-versus-invoker decision in section 0.1) and its test; then, if desired, a single pass on a hosted staging project with non-production data.
