# Claude assignment — dynamic tenant-owned size-band design

Base: `8bef156aa745aa958c329adeae66b2cba7cf0ccf` on `codex/parity-orchestration`.

## Objective

Produce the implementation design for parity item #21: tenant-owned, ordered dog size bands such as XS/S/M/L/XL/XXL. This is **design and dependency inventory only**. Do not return a migration or application patch in this assignment.

The current system supports editable XS–XL boundaries and per-size price/duration, but fixed keys remain embedded in booking, package eligibility, invoice pricing, and payroll. A visual add/delete control alone is not acceptable parity.

## Required design output

1. A complete fixed-size dependency inventory: every SQL migration/RPC, TypeScript type/helper, server action, component/form, export, test, and integration fixture that assumes XS/S/M/L/XL.
2. A proposed canonical data model with stable tenant-owned band identifiers/keys, human labels, ordering, lower/upper bounds, active/archive state, and overlap validation.
3. An upgrade plan from existing boundaries that preserves existing customer/pet, booking, package, invoice, and payroll semantics.
4. The authoritative calculation path for catalog price/duration, booking assembly, package eligibility, invoice snapshots, and payroll. Identify where immutable historical snapshots must be retained.
5. Rules for rename/archive/delete. Deletion must refuse while a live pet, booking, package, entitlement, or payroll dependency needs the band; explain the data-retention alternative if removal is desired.
6. Tenant/RLS/capability model and the exact permissions for owner management versus staff read-only use.
7. A migration sequence with uniquely allocated placeholder versions only; Codex assigns final timestamps after reviewing the design.
8. Fresh PostgreSQL 16, populated-upgrade, RLS, concurrency/idempotency, typecheck, and browser acceptance tests.
9. A rollout/rollback plan with feature flags or compatibility adapters where needed.

## Constraints

- Use forward-only migrations; never rewrite applied migrations.
- Preserve tenant isolation, branch scope, immutable financial snapshots, package ledger behavior, and payroll publication history.
- Existing price/duration values must continue to work during staged rollout.
- Do not build UI, do not deploy, and do not access production.
- Read `apps/web/AGENTS.md` and current repository sources before designing.

## Return format

Return only:

1. A gap/dependency table.
2. A recommended data model and migration sequence.
3. Calculation and snapshot flow diagrams in Markdown/Mermaid if useful.
4. A test matrix.
5. Explicit non-goals and open decisions.
6. The bounded source paths required for a follow-up implementation bundle.

## Curated source manifest

Supply only `CLAUDE-DYNAMIC-SIZE-MANIFEST.txt` plus the HomePaw reference excerpts needed to understand sizes/prices. Do not upload secrets or production data.
