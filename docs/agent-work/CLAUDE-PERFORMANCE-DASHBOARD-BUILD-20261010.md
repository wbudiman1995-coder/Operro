# Claude build brief — decision-ready performance dashboard

Date: 10 October 2026 (Asia/Jakarta)

## Assignment boundary

Build the next **single, reviewable** Operro capability: a decision-ready
performance dashboard for a business owner. This is a local implementation
task only. Do not deploy Vercel, apply remote Supabase migrations, access
credentials, create real accounts, invoices, payments, invitations, WhatsApp
messages, PRs, commits, merges, or pushes.

This brief is intentionally subsequent to the unreviewed 9 October parity
batch. Do not stack this work on top of an arbitrary dirty tree. Its expected
prerequisite is a Codex-reviewed baseline that includes the accepted
control-plane work and the remaining-nine work (custom fields, coat profile,
preferences, finance cash position, WhatsApp drafts, audit/reconciliation,
storage cleanup, and health/recovery). If the supplied checkout does not make
that state clear, perform reconnaissance and write a design-only handoff; do
not edit production code or add a migration.

## Accepted baseline and implementation decision

The prerequisite is now satisfied on
**`4902945 feat(parity): complete remaining HomePaw workstreams`**. Start from
that commit or a direct descendant that preserves it. Its remaining-nine
database/RLS suites, web suite, production build, and fresh PostgreSQL 16
Gates 4–8b have been reviewed by Codex. The untracked dispatch bundles,
prompts, handoffs, and test logs are not part of this feature and must remain
untouched.

Codex has also chosen the migration-backed option from the design handoff:

1. Allocate one forward migration after `20261029170000` (reserve
   `20261030100000_performance_dashboard.sql`, unless the checked-out lineage
   already contains a later allocated version).
2. Extend persisted dashboard-card validation for three new **organization
   owned** cards: `performance_operations`, `performance_finance`, and
   `performance_sources`. Preserve the existing four keys, reject unknown
   keys/values, and let an old valid four-key payload preserve the three new
   keys at their safe visible defaults. The current web form must send the
   complete new allowlist.
3. Add a bounded `security invoker` source-performance aggregate. It must
   return only normalized source buckets and counts—never customer identities
   or contact data—and derive tenancy/RLS from the active server context. It
   may report first completed bookings and first valid paid invoices only after
   tracing and documenting the authoritative status predicates.

This is now an implementation assignment, not a design-only stop. If the
actual base differs, has product-code modifications, or a newer accepted
migration occupies the reserved slot, stop and report the discrepancy rather
than guessing or overwriting it.

Treat every pre-existing modification and untracked file as user-owned. Never
reset, clean, stash, discard, overwrite, or silently fold it into this work.

## Product outcome

An authorized business owner should be able to answer, from one honest
dashboard:

1. How is the business performing over a selected Jakarta-local period versus
   the immediately preceding equal-length period?
2. Which existing customer sources are producing new customers and first
   completed/paid business, without pretending that a source has an ROI when
   no attributable marketing-spend data exists?
3. What revenue, collections, refunds, appointments, completed work, and
   outstanding invoices need attention?
4. Which numbers are unavailable because the viewer lacks the associated
   capability, rather than misleadingly displayed as zero?

Extend the existing dashboard, its organization-owned card-visibility setting,
and established finance/booking/customer loaders. Do not build a separate BI
database, event stream, accounting ledger, tracking-pixel product, browser
preferences, or generic report builder.

## First: establish the actual baseline

Read all of the following before writing code:

- `apps/web/AGENTS.md` and the relevant installed Next.js documentation before
  editing Next.js code.
- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`.
- `docs/handoffs/CLAUDE-CONTROL-PLANE-BATCH-HANDOFF.md`.
- `docs/handoffs/CLAUDE-REMAINING-NINE-TASKS-HANDOFF.md`.
- `docs/agent-work/CLAUDE-REMAINING-NINE-TASKS-20261009.md`.
- Existing dashboard routes/loaders/tests, finance cash-position and export
  loaders, booking/visit statistics, customer-source fields, invoice/payment/
  refund semantics, authorization helpers, and audit conventions.

Run and record:

```text
git status --short --branch
git log --oneline -12
git diff --stat
git diff -- apps/web supabase integration run_all_gates.sh
```

Start the handoff with a short evidence table containing: existing source
field/value semantics; the authoritative records and statuses for each
candidate metric; the relevant capability; Jakarta date source; and why the
metric is safe or excluded. If a required baseline feature is absent or dirty
in a way that prevents a clean distinction, stop after this design report.

## Scope

### 1. Date range and comparison contract

- Add a compact, validated dashboard period selector: today, last 7 days,
  last 30 days, this month, previous month, and a bounded custom inclusive
  range (maximum 366 Jakarta-local calendar days).
- Compare every selected period with its immediately preceding equal-length
  period. Define the boundaries once in a server-side shared helper; do not
  calculate dates in client-local time.
- Reject malformed, future-only, inverted, and overlong ranges safely. The
  default remains the existing dashboard behavior where that can be preserved.

### 2. Reusable, capability-scoped performance read model

Use one server-side dashboard read model that resolves organization, branch
scope, membership, capabilities, and timezone from authenticated context. Use
the reserved forward migration above; do not put aggregation logic in browser
code or introduce a second dashboard data system.

At most, surface these cards **when their exact existing semantics can be
proved**:

- new customers, grouped by the stored customer source;
- first completed booking and/or first valid paid invoice attribution by that
  source, with the definition visible in UI copy;
- completed versus cancelled appointments/visits;
- issued invoice total, valid payment/collection total, refund total, and
  outstanding invoice count/amount;
- cash movement summary only where the existing cash-position subsystem gives
  an authoritative currency-separated definition.

Do not label anything "profit", "ROI", "conversion", "retention", "cash on
hand", or "revenue" unless the exact existing records support it. In
particular, do not manufacture source ROI: when no source-attributable spend
exists, label the view as **source performance** and state that spend/ROI is
unavailable. Keep currencies separate; never sum across currencies.

Never expose gross amounts to a role lacking `finance.read`, payroll data to a
role lacking its established payroll capability, or customer identities/source
details to a role lacking the relevant customer capability. A card denied by
capability must render unavailable/hidden according to the existing dashboard
contract and must not run its underlying query.

### 3. Owner-facing dashboard surface

- Preserve the existing persisted card visibility allowlist and unknown-key
  rejection. Integrate the three decided card keys; default existing tenants
  safely, accept only the legacy four-key compatibility payload described
  above, and preserve unrelated organization settings.
- Show a period label, comparison label, definition/tooltips, empty state,
  unavailable state, and clear links only to existing authorized records or
  prefiltered pages. Do not expose organization identifiers through query
  parameters as authority.
- Make the source-performance display privacy-safe and bounded: no raw phone,
  address, private notes, payment proof, or unbounded customer list. "Other"/
  missing source must be reported honestly rather than discarded.
- Use Indonesian operational copy consistent with the current application.

### 4. Data safety and performance

- Derive all organization/branch scope from server context. Browser range/card
  choices are only validated display inputs, never tenancy authority.
- Reuse established status predicates. Void/deleted invoices, invalid/voided
  payments, refunds, cancelled work, archived customers, and corrected
  historical snapshots must follow their existing meaning; document each
  inclusion/exclusion decision.
- Bound aggregation queries and avoid N+1 source attribution. Do not add an
  unrestricted data export, generic SQL endpoint, materialized view, cron, or
  customer tracking collection.
- Preserve immutable invoice, payment, booking, package, audit, and payroll
  snapshots. This dashboard is read-only.

## Non-negotiable engineering rules

- Forward-only migrations only; never alter an applied migration. Add a
  migration to the gate manifest and populated-upgrade harness only if one is
  genuinely necessary.
- Reuse existing RLS, RPC authorization, loaders, finance semantics, audit
  patterns, and test fixtures. Do not create a second authorization or
  accounting subsystem.
- Any new `security definer` function needs `search_path = ''`, narrow input
  validation, explicit grants/revokes, capability and tenant checks, and
  PostgreSQL 16 RLS tests. Avoid one if a safe existing view/loader suffices.
- Do not access provider APIs, expose provider usage/billing, read secrets, or
  use a service-role key.
- Do not claim browser, database, security, or performance verification that
  you did not actually run. A static source assertion is not an RLS test.

## Required verification

Run what the supplied environment supports and put the exact command and raw
result in the handoff:

1. Focused dashboard unit/component tests covering Jakarta boundaries,
   equal-length comparison, range validation, card visibility fallback,
   missing source, no data, multiple currencies, cancellation/void/refund
   predicates, and capability-unavailable behavior.
2. Tenant/branch/capability denial tests. Prove a forged organization context
   cannot query another tenant, and prove finance cards do not load without
   `finance.read`.
3. Fresh PostgreSQL 16 migration/RLS tests if SQL/RPC/schema code changes;
   otherwise record why existing database contracts suffice. If a migration is
   introduced, run the populated-upgrade rehearsal.
4. Web typecheck, lint with zero warnings, production build, `git diff
   --check`, and the relevant existing dashboard/finance tests.
5. A real browser pass when a safe local/staging session and non-production
   test data are available: owner full dashboard, restricted role, empty
   period, source breakdown, range changes, and card visibility persistence.
   If unavailable, state it plainly—do not create or use real accounts.

## Required handoff and stopping point

Create `docs/handoffs/CLAUDE-PERFORMANCE-DASHBOARD-HANDOFF.md`. It must state:

- exact base branch/SHA and every pre-existing dirty file preserved;
- the initial evidence table and explicit metric definitions;
- changed files, reused subsystems, migration order (if any), and data model
  impact;
- authorization/tenant/branch/currency controls and query-bounding approach;
- raw verification results and browser-tested versus not-tested;
- all deliberately excluded metrics, especially any unavailable marketing
  spend/ROI calculation;
- unresolved risks and the next smallest safe task.

Return only the patch and handoff to Codex for review. Do not commit, push,
deploy, merge, or apply remote migrations.
