# Claude build brief — Operro parity control-plane batch

Date: 9 October 2026 (Asia/Jakarta)

You are taking over the existing Operro checkout for one substantial, reviewable build. Work from the current working tree exactly as supplied. Do not reset, clean, stash, discard, or overwrite existing edits. This is a local implementation task only: do not deploy Vercel, push Supabase migrations, create real accounts/invoices, open a PR, merge, or access credentials.

## First step: establish the real baseline

Run and record:

```text
git status --short --branch
git diff --stat
git diff -- apps/web supabase integration run_all_gates.sh
```

Read `apps/web/AGENTS.md`, `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`, `docs/handoffs/DEEPSEEK-DASHBOARD-AUDIT-HANDOFF.md`, `docs/handoffs/ENGINE-3-S32-S33-HANDOFF.md`, and `docs/agent-work/CLAUDE-DYNAMIC-SIZE-BUNDLE-4.md`. Treat every pre-existing modification as user-owned. Before editing, produce a short inventory separating: (a) changes already present and to be preserved, (b) defects that prevent safe integration, and (c) genuinely new work.

## Build objective

Finish and harden the in-progress control-plane batch so it is ready for Codex review:

1. **Dynamic size bands through payroll**
   - Preserve the forward-only migration lineage and stable tenant-owned band keys.
   - Ensure draft/unpaid payroll resolves current active dog bands server-side, while approved/paid payroll remains frozen.
   - Preserve old XS/S/M/L/XL history after rename/archive and refuse unsafe active dependency removal.
   - Ensure organization and staff size matrices validate against the row’s own organization and cannot be used for cross-tenant reads or writes.
   - Keep the current flat-rate behavior for cats, custom species, and unmeasured dogs where the existing contract requires it.

2. **Persisted dashboard card visibility**
   - Keep the existing server-scoped period comparison and capability-aware dashboard read model.
   - Finish the organization-owned card visibility setting using the existing organization settings JSON and `settings.manage` capability.
   - Hidden cards must not trigger their underlying data queries; restricted metrics must remain restricted, not become misleading zeroes.
   - Validate the complete allowlist server-side and preserve unrelated organization settings.

3. **Organization export foundation**
   - Finish the owner-authorized, bounded/chunked export already started in the working tree.
   - Export only an explicit reviewed allowlist of tenant rows and configuration plus Storage metadata; never export Auth secrets, service keys, token hashes, signed URLs, provider credentials, or another organization’s rows.
   - Keep idempotent chunk recording, deterministic paths, SHA-256 hashes, manifest versioning, interrupted-run behavior, and a metadata verifier.
   - Call this an export/archive, not a backup or restore product. Add a dry-run verification path only; do not claim disaster recovery until a disposable-project restore drill exists.

## Required engineering rules

- Derive organization, branch, role, and capability from the authenticated server context. Never trust a browser-supplied organization id beyond an equality/stale-write check.
- Use new forward-only migrations. Never edit an applied migration.
- Reuse existing RPCs, loaders, permissions, Storage policies, and test fixtures; do not create parallel analytics, payroll, export, or authorization systems.
- Preserve immutable invoice, booking, package, payment, evidence, and published-payroll snapshots.
- Every `security definer` function must have an explicit empty `search_path`, narrow input validation, explicit grants/revokes, and tenant/capability checks.
- Do not expose raw provider usage or billing estimates. Do not add speculative per-organization database-byte accounting.
- Keep UI copy truthful about draft, archived, user-reported, unverified, and not-yet-restored states.

## Required verification

Run what the environment supports and report exact raw results, not just a claim:

1. Focused TypeScript tests for dashboard settings, dynamic payroll, export manifest/hash verification, and existing related contracts.
2. Web typecheck, lint, and production build.
3. Fresh PostgreSQL 16 migration/test run covering dynamic-size payroll, dashboard-card authorization, export allowlist, and cross-tenant denial.
4. Populated-upgrade rehearsal from the existing integration harness.
5. `git diff --check` and a migration/grant review.

If Docker/PostgreSQL, npm dependencies, or browser access is unavailable, stop claiming only the checks actually completed and preserve the exact blocker. Do not replace a database/RLS test with a static assertion and call it equivalent.

## Required handoff

Create `docs/handoffs/CLAUDE-CONTROL-PLANE-BATCH-HANDOFF.md` containing:

- base commit/branch and the pre-existing dirty files preserved;
- exact files/migrations changed and why each existing subsystem was reused;
- migration order and rollback/forward-only notes;
- raw test, typecheck, lint, build, SQL, and populated-upgrade results;
- browser-tested versus not tested;
- organization/branch/capability/RLS checks;
- explicit deferred work: custom fields, coat profile/wash counter, WhatsApp queue, cross-entity audit/reconciliation, full backup/restore, scheduled cleanup, monitoring/recovery UI;
- a concise list of defects still blocking release.

Do not commit or deploy. Return the patch and handoff to Codex for review.
