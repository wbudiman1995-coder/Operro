# DeepSeek assignment — persistent tenant-scoped customer code

Base: `8bef156aa745aa958c329adeae66b2cba7cf0ccf` on `codex/parity-orchestration`.

## Objective

Implement exactly one parity improvement: a durable, tenant-scoped, human-readable customer code. This closes part of parity item #2 (Customer CRM). Do **not** implement bulk edit, pet editing, custom fields, dashboard changes, or dynamic size bands.

## Required behavior

- Every real customer row receives an immutable code in its organization, using `CUST-001`, `CUST-002`, … and preserving all digits after 999 (`CUST-1000`, not a truncated value).
- Codes are unique per organization, required after migration, and remain reserved after soft deletion.
- Backfill order is deterministic by `(created_at, id)` and numbering restarts per organization.
- A caller-supplied nonblank code must be rejected. An empty/whitespace field may be treated as absent.
- A code is assigned only when a real customer row is created. Do not synthesize UUID-derived display codes.
- Existing booking, invoice, package, payment, and payroll history must remain unchanged.
- Customer search, Customer 360, CRM export, invoice/customer selection, and visible customer lists must use the persisted code where applicable.
- Active organization and tenant scope must be resolved server-side. No browser-provided organization ID is authoritative.

## Reserved migration and test contract

- Reserve `supabase/migrations/20261023100000_customer_codes.sql`. Do not edit an earlier migration.
- Add a focused PostgreSQL 16 smoke/upgrade test. It must prove the 999 → 1000 boundary, two-organization isolation, deterministic backfill ordering including tied timestamps, soft-deleted reservation, uniqueness, and `NOT NULL`.
- Add a populated-upgrade rehearsal fixture that preserves existing booking/invoice/package/payroll values.
- Prove, as an authenticated principal in another organization, that cross-organization customer read **and write** are denied; verify the owner organization remains unchanged.
- Add or update focused TypeScript/web contract tests and wire the focused test into a command that actually runs in validation.
- Update `run_all_gates.sh` migration manifest and appropriate gate invocation only if the implementation is otherwise complete.

## Required review points

- Follow the repository's CRLF-safe temporary shell harness pattern for any concurrency test.
- Preserve the existing safe, bounded `.ilike()` search behavior.
- Inspect current customer creation paths before modifying them; do not invent parallel customer tables or direct browser writes.
- Read `apps/web/AGENTS.md` and relevant Next.js documentation before changing web files.

## Return format

1. A finding table: existing behavior, chosen change, HomePaw reference, risks.
2. A complete unified patch against the declared base, with no truncated diff lines.
3. Exact raw results for `git apply --check`, focused tests, database tests, typecheck, lint, and build; clearly label any check not run.
4. A handoff with changed paths, migration order, authorization evidence, browser-tested/not-tested boundaries, and the next smallest safe task.

## Curated source manifest

Supply the agent only the paths listed in `DEEPSEEK-CUSTOMER-CODE-MANIFEST.txt`, plus a sanitized HomePaw reference if needed. Do not upload `.env` files, keys, production exports, or unreviewed user data.

