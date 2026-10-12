# Claude build brief — Operro partial-parity closeout

Date: 12 October 2026 (Asia/Jakarta)

## Assignment

Take the eight capability areas still honestly marked **Partial** in the HomePaw parity map and move each as far as can be safely implemented and locally verified in one coherent, reviewable program. Work only in a clean checkout at:

```text
branch: codex/parity-orchestration
commit: 33fcad3fa108857b9a94ef5ee4e568fdcad477e3
```

This is local implementation work. Do **not** push, deploy, apply remote migrations, access secrets, contact providers, create real users/invitations/invoices/messages, or merge. Return an uncommitted patch and handoff for Codex review.

The 1 October audit is intentionally stale. The accepted baseline already contains dynamic size bands, organization export verification, custom fields, coat profiles, finance cash position/export, WhatsApp drafts, audit/reconciliation, storage cleanup/health, and the performance dashboard. Preserve all of it.

## First: baseline and design gate

Read in full before editing:

- `apps/web/AGENTS.md`
- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`
- `docs/handoffs/CLAUDE-CONTROL-PLANE-BATCH-HANDOFF.md`
- `docs/handoffs/CLAUDE-REMAINING-NINE-TASKS-HANDOFF.md`
- `docs/handoffs/CLAUDE-PERFORMANCE-DASHBOARD-HANDOFF.md`
- relevant existing routes, migrations, RPCs, tests, and bounded HomePaw reference excerpts.

Record this baseline before changes:

```text
git status --short --branch
git log --oneline -12
git diff --stat
git diff -- apps/web supabase integration run_all_gates.sh
```

Then write a concise design table for all eight streams: HomePaw behavior, accepted Operro baseline, proposed bounded behavior, schema/RPC impact, permission model, migration dependency, test plan, and what cannot be proven locally. Do not implement an external-provider integration, hosted restore, scheduled job, or marketing ROI calculation merely by faking its evidence.

If a real source-of-truth, provider account, or deployment decision is required, build only a safe, explicitly labelled local foundation and list the exact owner decision/action that remains. Never call that portion complete.

## Required streams, in this order

### P1 — Dashboard analytics and operational alerts (#1)

Extend the accepted performance dashboard rather than making a second BI system.

- Add bounded, capability-aware operational alerts only where an existing authoritative source and threshold can be defined (for example overdue issued invoices, expiring memberships, booking conflicts, or failed maintenance runs). Each alert must say what it measures and link only to an already-authorized surface.
- Add source-spend / ROI only if a tenant-owned, auditable marketing-spend model can be supplied without guessing attribution. Otherwise keep source performance and state ROI is unavailable; do not label counts as ROI.
- Preserve Jakarta-period semantics, separate currencies, card visibility, branch scope, and the existing rule that denied cards make no underlying query.

### P2 — Financial operations (#31)

Complete the safest useful remainder of the finance surface without rewriting invoices, payments, refunds, package ledgers, or payroll snapshots.

- Design and, if it can be made authoritative, implement a tenant/branch-scoped cash-account and capital/cash-movement workflow with immutable entries, corrections by reversal, a separate-currency position, source links, and audited permissions.
- Finish a formula-safe, bounded finance export only from existing authoritative rows. Do not silently combine currencies or call the result profit/accounting unless the records support that claim.
- If a double-entry ledger or bank reconciliation would be required for truthfulness, stop at a clearly labelled cash-control register and document the remaining accounting decision.

### P3 — WhatsApp operations (#34)

Build on `whatsapp_drafts`; do not create an unofficial sending or scraping integration.

- Add a capability-gated, tenant-safe batch workflow and auditable manual delivery log where the existing draft contract supports it: preview, eligibility/opt-out checks, dedupe, explicit user-reported outcomes, cancellation, failure/retry, bounded paging, and history.
- Do not claim WhatsApp-delivered/read status without a supported, configured provider webhook. Keep one-time onboarding links secret and unrecoverable.
- If a provider adapter is useful, make it disabled-by-default and configuration-free; specify the explicit provider, credential, consent, webhook, and staging decisions needed before enabling it.

### P4 — Organization export, restore readiness, and ownership (#38)

Extend the existing bounded export/verifier; do not replace it or call it a backup prematurely.

- Make the archive scope transparent and deterministic, including reviewed database/configuration/file metadata coverage, manifests, hashes, resumability, and retention/cancellation behavior.
- Build a local/disposable restore-readiness verifier or importer only if it can preserve tenant isolation and immutable financial history. It must be dry-run-first, reject unsafe/unknown input, avoid Auth secrets/provider credentials, and never point at production.
- Add a documented, reproducible disposable restore drill procedure and evidence-recording path. Do not assert a restore drill happened unless it actually did.

### P5 — Business configuration (#39)

Inspect the HomePaw reference and map remaining concrete business settings to existing authoritative Operro configuration.

- Expose only well-defined, owner-authorized settings with validation, concurrency protection, auditing, and sibling-JSON preservation.
- Do not introduce a generic arbitrary-JSON settings editor. Distinguish organization settings from personal preferences and from platform settings.

### P6 — Accounts and permissions live-readiness (#41)

Harden the existing access system; do not create actual invitations or use real mail.

- Add missing local-role/RLS and browser coverage for invitation claim, suspended workspace behavior, platform-owner switching, tenant Admin checklist denial, and restricted helper role denial.
- Improve truthful readiness/error surfaces only where needed. Produce a concise hosted-staging/manual QC script for the real invitation and multi-organization flow.

### P7 — Storage and maintenance automation (#43)

Build on the dry-run-first cleanup foundation.

- Add a safe scheduling integration only if this repository has a supported scheduler and service identity model. It must be opt-in, bounded, lease/lock protected, retryable/idempotent, auditable, and able to be disabled immediately.
- Never expose provider quotas as billing facts; do not invent per-organization database bytes. Keep real Storage behavior separately tested.
- If unattended scheduling needs an owner platform decision, ship the scheduler-ready, disabled state and an operator runbook rather than a fake cron.

### P8 — Reliability and recovery proof (#44)

Build on `/settings/health` and recovery readiness.

- Add only safe health signals backed by real existing records. Do not expose credentials, provider logs, raw database errors, or pretend to query provider backup status.
- Tie unresolved reconciliation/cleanup/export/restore-readiness status to clear owner actions. Preserve platform-vs-tenant redaction.
- Add a rigorous hosted staging/disposable restore-drill checklist and evidence format. A production restore is out of scope.

## Cross-stream constraints

- Work in the stated order. Use a new forward-only migration for each independently deployable schema slice; allocate chronological names after `20261030100000_performance_dashboard.sql`. Never alter an existing migration.
- Derive organization, branch, user, role and capability from authenticated server context; browser fields are display inputs, never authority.
- Preserve RLS, branch isolation, audit history, immutable financial snapshots, package entitlement rules, and historical booking/payroll results.
- Every new `security definer` function must use `search_path = ''`, validated narrow inputs, explicit grants/revokes, tenant/capability checks, and PostgreSQL role tests. Prefer `security invoker` when it preserves the required policy.
- Avoid generic report builders, raw SQL endpoints, broad exports, provider integrations with credentials, and unrelated refactors.
- Update `run_all_gates.sh`, the populated-upgrade rehearsal, and schema-version contract when migrations make that necessary. Do not falsify a version or mark an untested migration as applied.

## Required verification

Run and record exact commands and unedited results:

1. Focused unit/component tests for every changed stream, including empty/error/denied states.
2. Fresh PostgreSQL 16 migration/RLS suites with real `authenticated`/`anon` roles, cross-tenant denial, branch restrictions, direct-DML denial, and grant review.
3. A populated-upgrade rehearsal for every schema/data-model change.
4. Full web suite, root and web typecheck, zero-warning lint, production build, and `git diff --check`.
5. Local browser checks for each new surface using non-production data, including owner and restricted-role views. State clearly if no hosted staging or real Storage/provider test occurred.

Do not use a passing static source assertion as a substitute for database/RLS, Storage, provider, or browser evidence.

## Return package

Return exactly:

1. A unified patch against `33fcad3` (uncommitted) and a file list.
2. `docs/handoffs/CLAUDE-FINAL-PARITY-CLOSEOUT-HANDOFF.md` with one section per P1–P8: behavior delivered, HomePaw comparison, migrations, authorization, tests/raw outputs, browser evidence, limitations, and whether the stream is implemented or still partial.
3. An updated parity-audit proposal containing a count and row-by-row status rationale; do not claim full parity based on local evidence alone.
4. A release sequence: migration order, safe rollback-by-forward-migration notes, local/staging/manual owner checks, and any required external decisions.

Do not commit, push, deploy, create a PR, access credentials, or perform actions on a hosted Supabase/Vercel/WhatsApp environment.
