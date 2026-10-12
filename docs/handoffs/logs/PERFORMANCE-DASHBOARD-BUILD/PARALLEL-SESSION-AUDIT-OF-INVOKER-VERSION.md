# Claude handoff: decision-ready performance dashboard — IMPLEMENTATION AUDIT

Date: 10 October 2026 (Asia/Jakarta). Brief: `docs/agent-work/CLAUDE-PERFORMANCE-DASHBOARD-BUILD-20261010.md`.
This file replaces the earlier design-only handoff, which described the superseded base `45fc289` and is no longer accurate.

**Outcome:** the implementation already present in the working tree was audited read-only against the brief and the required verification was run on it. The audit found no defect that needed a code change, so **this session changed no product code, test, migration, or script**. The only files written by this session are this handoff and the raw logs in `docs/handoffs/logs/PERFORMANCE-DASHBOARD/`. Nothing was committed, pushed, deployed, merged, or applied to a remote Supabase project; no credentials were read; no account, invoice, payment, invitation, or WhatsApp message was created.

**Provenance caveat.** The implementation files were already in the tree (last written 22:08–22:15 WIB) when this session started; this session did not author them. They were audited as found. Codex should treat the audit and verification below as evidence about that code, not as a record of how it was written.

## 1. Base and dirty-tree state

- Repo `C:\Users\DW_wi\Documents\ChatGPT\Operro`, branch `codex/parity-orchestration`, HEAD `4902945 feat(parity): complete remaining HomePaw workstreams` (the accepted baseline). Raw: `logs/PERFORMANCE-DASHBOARD/git-status.txt`, `git-log.txt`, `git-diff-stat.txt`.
- `20261030100000` was free (newest committed migration is `20261029170000`), so the reserved slot is correctly occupied by this feature.
- **Tracked files modified (10), all part of this feature or its required wiring:**
  `apps/web/src/app/dashboard/page.tsx`, `apps/web/src/components/dashboard-shell.tsx`, `apps/web/src/lib/dashboard-read-model.ts`, `apps/web/src/lib/health.ts` (`EXPECTED_SCHEMA_VERSION` → `20261030100000`), `apps/web/test/control-plane-ui.test.tsx`, `apps/web/test/dashboard-read-model.test.ts`, `apps/web/test/remaining-nine-ui.test.tsx` (schema-version literal), `integration/run_populated_upgrade_rehearsal.sh`, `run_all_gates.sh`, `supabase/tests/20261029170000_test_health_recovery.sql` (hard-coded version `20261029170000` replaced by `app.schema_version()` shape checks, because every new migration moves the version).
- **New feature files (untracked):** `supabase/migrations/20261030100000_performance_dashboard.sql`, `supabase/tests/20261030100000_test_performance_dashboard.sql`, `integration/performance_dashboard_upgrade_probe.sql`, `apps/web/src/lib/dashboard-period.ts`, `apps/web/src/lib/dashboard-performance.ts`, `apps/web/src/components/performance-dashboard.tsx`, `apps/web/test/dashboard-period.test.ts`, `apps/web/test/dashboard-performance.test.tsx`.
- **Untracked, not part of this feature, left untouched:** `agent-bundles/*.zip` (including `Operro-Claude-Performance-Dashboard-4902945.zip`), `deepseek-outsourcing/`, `scripts/build-*.ps1`, `docs/agent-work/*` (including the brief), `docs/handoffs/logs/{CONTROL-PLANE,REMAINING-NINE,REMAINING-NINE-REVIEW-FIX}/`, `docs/handoffs/logs/INTEGRATION/sb06-populated-upgrade.log`.
- Line-ending note: git warns `LF will be replaced by CRLF` for the modified tracked files; `git diff --check` is clean.

## 2. Evidence table (predicates traced to source)

Timezone source: `app/dashboard/page.tsx` resolves one business time zone (default branch's, or the lowest-sorted granted branch's) and passes it to both `resolveDashboardPeriod` and the aggregates. A branch-restricted viewer with branches in different time zones sees the lowest-sorted one — pre-existing behavior, not reconciled here.

| Metric | Records / statuses used (and where confirmed) | Capability and scope | Verdict |
|---|---|---|---|
| Appointments completed / open / canceled / no-show | `bookings.status` check constraint (`20260721000500`): draft, requested, confirmed, in_progress, completed, canceled, no_show. By `starts_at`; `deleted_at is null`; draft excluded; open = requested+confirmed+in_progress. No `completed_at` column exists, so "completed in period" is by start time (stated in UI copy). | `booking.read` + `scheduling` module, not a groomer member; branch rows via bookings RLS | Safe |
| Manual visits (off-books) | separate table, no status to split on | — | **Excluded**; UI says so |
| New customers by source | `customers.source` is free text (nullable, `20260721000400`). Bucket = trim, collapse whitespace, case-fold; empty → "Tanpa sumber". `deleted_at is null` and `status <> 'archived'` (status: lead/active/inactive/archived), by `created_at`. | `customer.read` or `customer.manage`, `crm` module, `branches.all` (customers carry no `branch_id`, so a branch-limited viewer cannot get a faithful count → "unavailable", never zero) | Safe |
| First completed booking by source | customer's earliest `completed`, non-deleted booking over **all history** falls in the period | `booking.read`; column is `NULL`/"—" without it | Safe |
| First valid paid invoice by source | customer's earliest `succeeded` payment on a non-`void` invoice (all history) falls in the period; payments without an invoice customer are ignored | `finance.read`; `NULL`/"—" without it | Safe |
| Source attribution caveat | uses the customer's **current** source; editing it re-attributes past periods (stated in UI) | — | Documented |
| Issued invoice total | `invoices.status <> 'void'` (issued/paid) by `issued_at`, per `currency` (`chk_invoices_status`: issued, paid, void) | `finance.read` + `finance` module; RLS branch scope | Safe |
| Collections | `payments.status = 'succeeded'` by `paid_at`, per currency — identical predicate to `app.finance_cash_position` and to `app.fn_invoice_paid_total`. Payments on later-voided invoices are still counted (as in cash position) and flagged with an on-screen warning count. | `finance.read` | Safe |
| Refunds | `refunds.status = 'succeeded'` by `refunded_at`, currency from the refunded payment (same join as cash position). No application code inserts refunds (only `finance-export.ts` reads them), so zeros are expected until a refund workflow exists. | `finance.read` | Safe |
| Outstanding invoices (snapshot "now") | `invoices.status = 'issued'` and `total` > succeeded payments; zero-total invoices excluded. Matches `app.record_payment`, which flips to `paid` when `fn_invoice_paid_total >= total` and refuses `total = 0`. Overdue = `due_at < now()`. | `finance.read` | Safe; labelled as a position today, not per period |
| Cash movement | `app.finance_cash_position` exists but is month-bucketed and includes expenses | — | **Excluded** (no duplicate or competing cash number) |
| Profit, ROI, conversion, retention, cash on hand, payroll | no spend table, no balance, no funnel | — | **Excluded**; UI states that per-source marketing spend and ROI are unavailable |

Not reused on purpose: the existing "Pendapatan tercatat" card (`loadDashboardData`) sums payments without a currency filter and adds manual billing. That is pre-existing, untouched, and now labelled in the new section as distinct ("kartu hari ini tidak mengikuti periode"). Fixing it is a separate task.

## 3. What the implementation does (as audited)

- **Period contract** (`lib/dashboard-period.ts`, single definition): presets today / 7d / 30d / this month / last month, plus custom inclusive range (`?period=custom&from=&to=`), all in business-time-zone calendar dates via `zonedDayISO` / `addDaysISO`. The previous range is the immediately preceding equal-length range. Malformed, inverted, future-only, past-today, over-366-day, unknown-preset and over-old (<2000-01-01 comparison) input falls back to today with an Indonesian message; no query string keeps the existing default. The database independently rechecks adjacency, equal length, ≤366 days, bounds, and a real time-zone name (`app.dashboard_check_periods`).
- **Migration `20261030100000_performance_dashboard.sql`** (forward-only; occupies the reserved slot; added to `EXPECTED_MIGRATIONS`):
  1. `create or replace app.update_dashboard_card_settings` (`security definer`, `search_path = ''`, `settings.manage` + membership + active-org checks, same revoke/grant): allowlist is the four legacy keys plus `performance_operations`, `performance_finance`, `performance_sources`. Legacy keys stay mandatory booleans; unknown keys rejected; the three new keys arrive all-or-none; a legacy four-key payload preserves stored values of the new keys (absent stays absent = visible); sibling `settings` keys untouched.
  2. Four `security invoker` / `stable` / `search_path = ''` read functions: `dashboard_check_periods`, `dashboard_operations_performance`, `dashboard_finance_performance`, `dashboard_source_performance`. The organization comes from `app.fn_active_organization()`, never an argument. Explicit capability/module checks raise `42501` so a denied caller gets an error, not an RLS-emptied zero. Source function returns only bucket label, flags and counts; at most ten named sources plus one "other" row and one "missing" row per period; no identities, contact data, notes, proof, or amounts. All execute grants are `authenticated` only (revoked from `public`, `anon`).
  3. Five supporting indexes (`bookings`, `invoices`, `payments`, `refunds`, `customers` by organization + date column).
  4. `app.schema_version()` → `20261030100000`.
  No `security definer` was added except the replaced card-settings function. No table, view, materialized view, cron, or ledger was created.
- **Loader** (`lib/dashboard-performance.ts`): `loadDashboardPerformance` uses `buildPerformanceReadPlan` (in `dashboard-read-model.ts`) so a card that is hidden, or whose capability / branch grant is missing, **issues no RPC** and yields `hidden` / `restricted`. DB `42501` → `restricted`; a missing function (`PGRST202`/`42883`) or any other failure → `unavailable` with a reason — never a number. Money is grouped per currency and never summed; no organization identifier is sent.
- **UI** (`components/performance-dashboard.tsx`, mounted from `dashboard-shell.tsx`): period presets as links, bounded custom-range GET form (`max` = today, ≤366 days), period and comparison labels, per-figure "vs previous" text in neutral wording, collapsible "Definisi angka", empty states, unavailable/restricted states, a multi-currency notice, and an explicit note that per-source marketing spend and ROI are not recorded. Links go only to `/schedule`, `/finance`, `/customers`. The settings form lists all seven keys (`dashboard-settings-form.tsx` and `dashboard/actions.ts` iterate `DASHBOARD_CARD_KEYS`, so the web form sends the complete allowlist).

## 4. Authorization, tenancy, branch, currency, bounding

- Tenant: derived in SQL from the authenticated session; cross-tenant and forged-org cases are in the PG16 test (settings write and all three aggregates).
- Capability: both the loader (no call) and the database (`42501`) enforce `booking.read`, `finance.read`, `customer.read|manage`, module flags, and not-groomer where relevant. Source columns that depend on a second capability are `NULL` → "—", not zero.
- Branch: operations and finance rely on bookings/invoices/payments RLS; the PG16 test proves a branch-limited finance user never sees South rows. The customer-wide source breakdown requires `branches.all`.
- Currency: every money figure is per currency; the UI never adds across currencies.
- Bounding: periods ≤366 days (two windows), indexed date predicates, top-10 source folding, first-event checks evaluated only for candidates inside the two windows (no N+1). The populated-upgrade probe measured the three aggregates at ~0.12 s on the rehearsal workspace; that is one data point on a small dataset, **not** a load or scale benchmark.

## 5. Verification actually run (raw results)

All commands ran on 10 Oct 2026 against the tree described in section 1. Migration SHA-256 `7c416abb…8a3926` was identical for the web and database runs. Logs: `docs/handoffs/logs/PERFORMANCE-DASHBOARD/`.

| Check | Command | Result |
|---|---|---|
| Focused web tests | `npm exec -- tsx --test test/dashboard-period.test.ts test/dashboard-performance.test.tsx test/dashboard-read-model.test.ts test/control-plane-ui.test.tsx test/health-recovery.test.ts test/remaining-nine-ui.test.tsx` (in `apps/web`) | `tests 63 / pass 63 / fail 0` (`web-focused-tests.log`) |
| Full web suite | `npm exec -- tsx --test test/*.test.ts test/*.test.tsx` | `tests 642 / pass 642 / fail 0`, exit 0 (`web-full-tests.log`) |
| Typecheck | `npm run typecheck` | exit 0 (`web-typecheck.log`) |
| Lint, zero warnings | `npm run lint -- --max-warnings=0` | exit 0, no output (`web-lint.log`) |
| Production build | `npm run build` | exit 0 (`web-build.log`) |
| `git diff --check` | `git diff --check` (tracked files) | exit 0 (`git-diff-check.log`). New untracked files checked separately for trailing whitespace: none. |
| Fresh PostgreSQL 16 gates | `run_all_gates.sh` with GATE 1–3 (Node gates, already covered by the web runs above) stripped, inside a **fresh disposable `postgres:16` container** (WSL docker, repo copied to `/tmp`, CRLF stripped from `.sh`), `RUN_AS_POSTGRES=0` | Ended `ALL GATES PASSED`: gates 4, 4b (includes `20261030100000_test_performance_dashboard.sql` — 50 `PASS` notices — and the updated health test), 4c, 4d, 5, 6, 6b, 7, 7b–7m, 7h, 8, 8b (`db-gates.log`, 860 `PASS` lines, no `FAIL`) |
| Populated upgrade | `bash integration/run_populated_upgrade_rehearsal.sh` from a copy of the repo (own disposable PG16 container) | `PERFORMANCE DASHBOARD POPULATED PROBE PASS`, `POPULATED UPGRADE PASS`, exit 0 (`populated-upgrade.log`) |
| Mutation checks | 10 hand-made faults in the migration (collected counts non-succeeded; first-paid ignores void; finance.read check swapped; operations include soft-deleted; adjacency check dropped; archived customers counted; first-completed ignores history; `branches.all` requirement dropped; refund status ignored; 366-day cap raised), each applied to a clone of the gated DB and run against the new PG16 test | **10/10 killed** (`mutation-checks.log`) |

Fixture caveat: bare PG16 lacks Supabase's default table grants, as in earlier batches; the SQL test states what it needs. Real PostgREST/Supabase grants were **not** exercised.

## 6. Browser-tested versus not tested

- **Not browser-tested.** `apps/web` has only `.env.example`; there is no local Supabase environment, session, or non-production data, and no real account was created. The owner view, restricted role, empty period, source breakdown, range changes, and card-visibility persistence were therefore covered only by server-rendered component tests (`renderToStaticMarkup`), the loader tests against a recording client, and the PG16 tests — not by a browser. Layout, responsive behavior, and the GET range form in a real browser are unverified.
- Not exercised: PostgREST exposure of the four new RPCs (the migration ends with `notify pgrst, 'reload schema'`; a Supabase staging project has not been given the migration), RLS under Supabase's real default grants, and query plans on production-sized data.

## 7. Deliberately excluded

Profit, ROI, per-source ROI or cost (no attributable spend data exists), conversion, retention, cash on hand, payroll figures, manual-visit (off-books) counts, expenses and the month-bucketed cash-position report, a source drill-down to individual customers, exports, saved/custom reports, and any change to the existing "today" cards or their revenue arithmetic.

## 8. Unresolved risks and next smallest safe task

1. **Attribution drifts with edits**: source is a current free-text field; re-attribution of history is documented in the UI but unavoidable without a source-history table.
2. **Branch-limited viewers get no source breakdown** (customers have no branch). Correct and honest, but a product decision may want a branch-scoped alternative.
3. **Collections include payments on voided invoices** (consistent with cash position); the warning count is shown but the cleanup belongs in Finance/reconciliation.
4. **Existing "Pendapatan tercatat" card still ignores currency** — separate pre-existing task.
5. **Refunds will read zero** until some workflow inserts them.
6. **Unreviewed provenance**: this code was found in the tree, not written by this session; the mutation checks and gates support correctness but do not replace Codex review of the SQL.
7. The `20261029170000` health SQL test was edited (version literal → `app.schema_version()` shape) and `health.ts` / one UI test literal were bumped; Codex should confirm that coupling is acceptable.

**Next smallest safe task:** Codex review of `20261030100000_performance_dashboard.sql` and its test; then, with a local or staging Supabase project and non-production data, one browser pass (owner, restricted role, empty period, source breakdown, range changes, card-visibility persistence) and an `EXPLAIN` run on a realistically sized dataset.
