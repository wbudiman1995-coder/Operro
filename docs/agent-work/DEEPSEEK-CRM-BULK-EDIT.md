# DeepSeek assignment — bounded CRM bulk edit

Base: `e6736b045db801e5c62aaee96bdcc6162a04e2f1` on `codex/parity-orchestration`.

## Objective

Close the remaining bulk-edit portion of HomePaw parity item #2 without changing the customer schema. Add a safe multi-select workflow to `/customers` that lets an authorized user update the status and/or acquisition source of up to 100 visible customers at once.

This is an application slice only. Migration slots `20261023100000` through `20261023130000` are reserved for the separately reviewed dynamic-size bundle. Do not create or edit a migration.

## Required behavior

- Preserve the existing persisted `customers.customer_code` implementation. Never synthesize a UUID code and never rename it to `code` in the database.
- Show row checkboxes and the bulk toolbar only when the server-resolved capability map grants `customer.manage`.
- Support selecting individual visible customer rows and selecting/clearing all rows currently visible after the client-side search and filters.
- Limit one request to 100 unique customer UUIDs. Reject malformed JSON, non-UUID values, empty selections, and oversized selections server-side.
- Allow these changes only:
  - `status`: unchanged or one of `lead | active | inactive | archived`.
  - `source`: unchanged, set to a trimmed value of at most 80 characters, or clear to `null`.
- Require at least one actual requested field change. Do not accept arbitrary column names or a client-supplied patch object.
- Resolve the active organization and `customer.manage` capability on the server with `requireActiveWorkspace()`. Never accept an organization ID or permission flag from the browser.
- Execute the update through the request's authenticated Supabase client, scoped by the server-resolved `organization_id`, selected IDs, and `deleted_at is null`.
- Use one bounded `UPDATE` statement for the requested fields. Return the number updated and the number unavailable/skipped. Do not report full success when fewer rows were updated.
- Existing customer audit triggers must remain authoritative. Do not write directly to `app.audit_log`.
- Never modify `customer_code`, names, phone numbers, notes, addresses, pets, bookings, invoices, packages, payments, or payroll from this bulk action.
- Revalidate `/customers` after a successful nonzero update.
- Do not leak raw database error messages to the browser. Log unexpected detail server-side and return a stable Indonesian message.

## UI contract

- Add the smallest accessible UI to `CustomerDatabase`; extracting a focused client component is allowed if it improves clarity.
- Preserve current search, source filter, missing-coordinate filter, sorting, customer/pet tabs, links, and responsive table behavior.
- Selection must use customer UUIDs internally and display the persisted customer code/name to the user.
- The master checkbox applies only to the currently visible customer rows, not hidden filtered rows.
- Disable submission when no visible selections exist, while pending, or when neither status nor source has a requested change.
- Show the exact updated/skipped result. Clear the selection only after a successful nonzero update.
- Do not add destructive bulk deletion or bulk archival confirmation flows in this task. `archived` is an allowed status value, but the user must explicitly choose it from the status control.

## Tests and validation

- Add `apps/web/test/customer-bulk-edit-contract.test.ts` and wire it into the existing Gate 3 web test invocation in `run_all_gates.sh`.
- The contract test must guard:
  - server-side `customer.manage` enforcement;
  - no browser-provided organization ID or permission flag;
  - UUID validation, deduplication, and the 100-row limit;
  - the status whitelist and bounded source handling;
  - organization, selected-ID, and `deleted_at` predicates on the update;
  - `customer_code` never appears in the update payload;
  - explicit updated/skipped result handling;
  - capability-gated checkboxes/toolbar and visible-row selection behavior.
- Extend the existing authenticated customer RLS smoke test only if needed to prove that an authenticated member of organization B cannot bulk-style `UPDATE` an organization-A customer and that the owner row remains unchanged. Do not weaken or replace its existing assertions.
- Run, or honestly mark not run:
  - focused customer-code, search/profile, and new bulk-edit tests;
  - TypeScript typecheck;
  - ESLint with zero warnings;
  - production build;
  - applicable PostgreSQL/RLS test if changed;
  - `git diff --check`.

## Out of scope

- Customer 360 single-record editing.
- Pet editing.
- Custom fields.
- Tags or JSON merge semantics.
- Bulk delete, bulk archive shortcuts, import, export, or undo.
- New migrations, RPCs, service-role clients, admin clients, deployment, remote Supabase changes, or production data.
- Dynamic size bands and any Claude-owned work.

## Return format

1. Findings table: current behavior, chosen change, risks, and exact affected paths.
2. One complete unified diff against the declared base; no truncated lines or illustrative fragments.
3. Exact raw validation output, with every unrun command marked `NOT RUN`.
4. Handoff: changed paths, authorization evidence, updated/skipped semantics, browser-tested/not-tested boundary, and next smallest safe task.

