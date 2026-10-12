# Claude build brief — complete the remaining nine Operro parity tasks

Date: 9 October 2026 (Asia/Jakarta)

## Objective and scope

Complete the nine remaining, independently reviewable parity tasks in the existing Operro checkout. The already-complete baseline must remain intact:

- `a2c5fe6` — dynamic size-band payroll integration (E2.1)
- `25f150e` — organization export and restore verifier (E3.1)
- `45fc289` — persisted dashboard card visibility (E1.1)

Work locally only. Do **not** reset, clean, stash, discard, overwrite, commit, push, deploy, apply remote migrations, access credentials, create real accounts/invitations/invoices, open a PR, or merge. Treat every existing modification and untracked file as user-owned until you have inspected it.

Read `apps/web/AGENTS.md`, `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`, `docs/handoffs/CLAUDE-CONTROL-PLANE-BATCH-HANDOFF.md`, and the three 9 October queue files under `deepseek-outsourcing/2026-10-09/` before editing. First capture and report:

```text
git status --short --branch
git diff --stat
git diff -- apps/web supabase integration run_all_gates.sh
```

## Required sequence

Implement in this order. Produce a discrete section in the handoff for each task; do not conceal scope changes by bundling unrelated features.

1. **E1.2 — Customer 360 custom fields (#3, #40).** Build the smallest tenant-scoped, owner-configurable definition/value system for Customer 360 and pet editing. Support only short text, number, date, yes/no, and single-select; stable definition IDs; entity scope; ordering; active/archive state; validated options; RLS-safe values. Do not add public onboarding, generic formulas, arbitrary JSON, search, or exports. Cover archived definitions, changed options, invalid/formula-like values, old records without values, and tenant isolation.
2. **E1.3 — Pet coat profile and derived wash count (#4).** Add only the structured grooming/coat fields demonstrated by the HomePaw reference. Derive the visit/job count from authoritative completed work; never store a user-editable counter. Preserve booking, invoice, evidence, snapshot, and archive semantics. Cover cancelled versus completed work, archived pets, empty history, repeats, invalid input, and tenancy.
3. **E1.4 — Business settings and personal defaults (#39, #42).** Expose one existing authoritative organization setting used by the reference and one persisted per-user default (landing page or calendar view). Keep organization-owned configuration distinct from user preferences, validate allowed routes/views, and fail safe after access revocation. Do not add translation. Cover owner-only writes, malformed values, fallbacks, user/tenant isolation, and revoked access.
4. **E2.2 — Finance XLSX export and cash position (#31).** Reuse authoritative payment, refund, and expense loaders to implement a formula-safe XLSX export and a read-only cash summary by currency and period. Require `finance.read`; do not mutate history or create an accounting ledger. Cover pagination, filters, mixed currency, refunds, empty data, formula-like values, and tenant isolation.
5. **E2.3 — WhatsApp draft center (#34).** Build a tenant-scoped queue of existing invoice, follow-up, renewal, and onboarding `wa.me` drafts plus an auditable user-reported lifecycle: `draft`, `opened`, `marked-sent`, `failed`, `canceled`. Never auto-send, scrape WhatsApp Web, use an unofficial API, or claim provider-confirmed delivery. Cover opt-out/missing phone, template variables, idempotency, archived sources, permission checks, cross-tenant records, and audit entries.
6. **E2.4 — Cross-entity audit and read-only reconciliation (#36, #37).** Add a capability-gated audit viewer using existing audit data, with filtering, labels, actor resolution, and changed-field summaries. Separately add a read-only discrepancy view for completed visits lacking valid invoices, issued invoices with unreconciled valid payments, and published payroll whose source was voided/missing. Never auto-repair or invent history. Cover pagination, branch/org scope, void/refund/mixed currency, clean/broken fixtures, and deleted-source edges.
7. **E3.2 — Access-policy regression suite (#41).** Add a permanent PostgreSQL 16 role/RLS suite proving platform owner access to suspended workspaces and their tenant-Admin checklist; denial for tenant Admin management of that checklist; and denial for `Bantuan Operro` to payroll, finance reporting, and access management. Preserve the platform-owner superuser policy. Do not rely on hidden UI for security or create real users/invitations. Cover cross-tenant and revoked/suspended states.
8. **E3.3 — Safe scheduled storage-cleanup foundation (#43).** Extend existing retention/cleanup patterns with a dry-run-first bounded job, retry/idempotency, locking/concurrency protection, audit output, and metadata-before-object-deletion checks. Do not add database-byte estimates or billing automation. Cover active references, retention boundaries, absent Storage objects, partial failure, tenant isolation, retries, and concurrent runs.
9. **E3.4 — Health and recovery readiness (#44).** Add a read-only owner/platform health surface based only on safe existing signals: migration/app version, failed bounded maintenance jobs, pending capacity requests, and stale/error states. Add a recovery-readiness report/runbook containing last verified restore-drill metadata and unresolved reconciliation counts. Do not expose credentials, raw provider logs, provider billing estimates, or claim recovery is proven without a real drill. Cover authorization, tenant redaction, stale/failure states, and missing provider APIs.

## Cross-cutting non-negotiables

- Derive organization, branch, capability, and role from authenticated server context. Do not trust browser-supplied tenancy identifiers.
- Add only forward-only migrations; never edit an applied migration.
- Reuse existing loaders, RPCs, permissions, audit mechanisms, retention jobs, Storage policies, and fixtures where possible. Avoid parallel authorization, accounting, audit, or cleanup systems.
- Preserve immutable invoice, booking, payment, package, evidence, and published-payroll snapshots.
- Every new `security definer` function needs `search_path = ''`, narrowly validated inputs, tenant/capability checks, explicit grants, and revokes from `PUBLIC`/`anon`.
- UI language must distinguish draft, user-reported, dry-run, archived, unverified, export, and restore-readiness states accurately.

## Required verification

Run the targeted TypeScript/UI tests, typecheck, lint, production build, and a fresh PostgreSQL 16 migration/RLS suite for the new work. Run the populated-upgrade rehearsal where migrations affect existing data. Perform `git diff --check` and a grant/migration review. Record exact commands and raw outputs. If a dependency is unavailable, report the exact blocker; never label static assertions as equivalent to database/RLS or browser verification.

## Required handoff

Create `docs/handoffs/CLAUDE-REMAINING-NINE-TASKS-HANDOFF.md` with:

- base branch/commit plus every preserved pre-existing dirty file;
- one section per E1.2 through E3.4 listing changed files, migrations, reused subsystems, security/tenant checks, tests and limitations;
- migration ordering and forward-only notes;
- exact test/typecheck/lint/build/SQL/populated-upgrade output;
- browser-tested versus not-tested;
- any remaining blockers or consciously deferred work.

Return the patch and handoff only; do not commit or deploy.
