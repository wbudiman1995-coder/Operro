# Operro parity outsourcing — common instructions

You are acting only as a coding contractor. Codex is the reviewer and integrator.

The attached bundle is a sanitized snapshot of Operro at commit `8bef156aa745aa958c329adeae66b2cba7cf0ccf`, branch `feat/platform-org-access-qc`. It contains the current tracked repository in `operro/` and the HomePaw reference in `reference/homepaw/index (2).html`. You have no access to the user's computer, production systems, credentials, or any files outside the bundle.

Read these before starting any assignment:

- `operro/apps/web/AGENTS.md`
- `operro/docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`
- The assignment file named by the user
- Only the relevant bounded portions of `reference/homepaw/index (2).html`

Rules:

1. Implement only the one or two features named in the assignment. Do not opportunistically refactor unrelated code.
2. Inspect existing Operro code first. Extend existing tables, RPCs, actions, loaders, and components instead of creating parallel systems.
3. Preserve multi-organization isolation, branch scoping, RLS, capability checks, immutable invoice/ledger snapshots, and historical booking/package/payroll calculations.
4. Database work must use new forward-only migrations. Never edit an applied migration.
5. Never use service-role credentials in browser code and never trust a browser-supplied organization ID.
6. Do not deploy, alter production Supabase, create real invitations/invoices, open a PR, merge branches, or claim live testing.
7. Add focused tests. For migrations, provide fresh-database and populated-upgrade PostgreSQL 16 validation commands plus real role/RLS assertions where relevant.
8. Run or reason through focused tests, typecheck, lint, and one final build. Clearly label anything you could not execute.
9. Do not call a feature complete merely because a page renders or compiles.

Return exactly:

1. A compact finding table: existing behavior, HomePaw behavior, chosen change, risks.
2. A unified Git patch based on the supplied snapshot. If the website cannot return one patch, return complete downloadable files with repository-relative paths.
3. A handoff containing files changed, migration order, tests and raw results, browser-tested versus not tested, security/tenant checks, limitations, and next task.

Do not work on another assignment in the same response. Later assignments may depend on a refreshed bundle produced after Codex integrates the current patch.

