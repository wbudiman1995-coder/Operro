# DeepSeek assignment — guarded Customer 360 profile editing

Base: `5d454fe` on `codex/parity-orchestration`.

## Objective

Add a safe customer-only edit flow to `/customers/[customerId]` for these existing columns:

- `display_name`
- `phone`
- `email`
- `source`
- `notes`

This is an application-only parity slice. Do not create or edit a migration. Do not edit pets, sizes, addresses, custom fields, status, customer code, tags, metadata, portal identity, or soft-delete state.

Claude is working separately on dynamic-size Bundle 2. Do not touch catalog, size-band, service-price, package, booking, invoice, payroll, migration, or dynamic-size integration files.

## Required behavior

1. Add the action in a new route-local file such as `apps/web/src/app/customers/[customerId]/actions.ts`. Do not add it to the bulk-edit action file.
2. Resolve the organization, authenticated Supabase client, and capabilities only through `requireActiveWorkspace()` on the server.
3. Require `workspace.capabilities["customer.manage"]`. Hiding the form is not authorization.
4. Validate the customer ID as an RFC-compatible UUID before any query.
5. Build a fixed update payload containing only the five allowed columns. Never spread form input into a database payload.
6. Scope the single update by:
   - `organization_id = workspace.activeOrganization.id`;
   - the validated customer ID;
   - `deleted_at IS NULL`;
   - the exact expected `updated_at` value loaded with the page.
7. Use that `updated_at` predicate as optimistic concurrency. If zero rows return, show a stable Indonesian stale/not-found message and do not claim success. Do not silently overwrite a newer edit.
8. Return only stable user-facing errors. Log unexpected database details server-side; never return raw database messages, SQL, or identifiers to the browser.
9. On success revalidate `/customers` and `/customers/[customerId]` and show a clear success state. Refresh the displayed values without requiring the user to navigate away.
10. Preserve the database audit trigger. Do not create a duplicate audit/timeline row in application code.

## Validation and normalization

Use pure, independently testable parsing/normalization helpers.

- Name: trim; required; 1–120 Unicode characters.
- Phone: trim; optional; normalize an empty value to `null`; maximum 40 characters. Do not invent international-number rewriting for storage.
- Email: trim and lowercase; optional; normalize empty to `null`; maximum 254 characters; reject obvious invalid forms without pretending to implement full RFC 5322.
- Source: trim; optional; normalize empty to `null`; maximum 80 characters.
- Notes: trim trailing/leading whitespace; optional; normalize empty to `null`; maximum 4,000 characters; preserve internal newlines.
- Reject non-string/multiple-value input rather than coercing arrays or objects.
- Never accept `organization_id`, capability flags, status, code, `updated_at` replacement, or arbitrary column names from the browser.

## UI requirements

- Show an “Edit profile” control near the Customer 360 header only when `customer.manage` is true.
- Keep the existing header, tabs, address flow, restricted finance behavior, WhatsApp link, and all read-only tabs intact.
- Use a compact accessible form/dialog/details panel populated from the current overview.
- Include labels, disabled/pending state, success/error announcement (`aria-live` or equivalent), cancel/reset behavior, and usable 375 px layout.
- A user without `customer.manage` sees no mutation control and the page remains read-only.
- Do not add a second data loader. Extend the existing overview shape only as needed to carry `updatedAt`.
- Do not edit pet fields from this form. Pet CRUD waits for the stable dynamic-size adapters.

## Expected file scope

Prefer this bounded change set:

- new `apps/web/src/app/customers/[customerId]/actions.ts`
- new `apps/web/src/lib/customer-profile-edit.ts` for pure parsing helpers
- new `apps/web/src/components/customer-profile-editor.tsx`
- edit `apps/web/src/app/customers/[customerId]/page.tsx`
- edit `apps/web/src/lib/customer-360.ts` only to return `updatedAt`
- focused new test such as `apps/web/test/customer-profile-edit.test.ts`
- edit `run_all_gates.sh` only to add the focused test

Do not edit `apps/web/src/app/customers/actions.ts`, `customer-bulk-editor.tsx`, `customer-bulk-selection.ts`, or the CRM bulk-edit contract test.

If safe implementation requires another production file, explain why before widening scope. Do not add dependencies.

## Required tests

Add behavior tests for the pure parser:

- valid full input;
- trimming and nullable blank fields;
- email lowercasing and invalid email rejection;
- every length boundary;
- non-string/multiple-value rejection;
- internal note newline preservation;
- payload contains exactly the five allowed keys.

Add structural/action contract coverage proving:

- server-derived workspace and `customer.manage` authorization;
- no browser-provided organization or permission flag;
- UUID and expected timestamp validation occurs before the update;
- exactly one customer update;
- organization, ID, `deleted_at`, and `updated_at` predicates are present;
- `.select(...)`/returned-row count distinguishes success from stale/not-found;
- no customer code, status, pet, metadata, tags, address, or arbitrary-field mutation;
- UI is capability-gated and wired with the server-loaded expected version;
- the full gate invokes the new focused test.

Run and report exact results for:

1. the new focused test plus existing `customer-bulk-edit-contract.test.ts`, `customer-code-contract.test.ts`, `search-and-profile.test.ts`, and `authorization.test.ts`;
2. `npm run typecheck`;
3. `npm run lint --workspace apps/web -- --max-warnings=0`;
4. `npm run build --workspace apps/web`;
5. `git diff --check`.

If your chat environment cannot execute commands or edit the repository, do not claim that any check passed. Return the complete patch/file contents, list each command above as **not run**, and leave integration and verification to Codex.

No fresh database migration test is required because this task may not change schema or policies. Existing tenant-update RLS evidence remains authoritative; do not weaken or rewrite it.

## Stop conditions

Stop and report instead of guessing if:

- the base is not `5d454fe` or does not contain CRM bulk-edit commit `5d454fe` and Bundle 1 commit `8758cff`;
- Claude's concurrent task has modified one of your bounded files;
- the current schema does not expose one of the five stated columns;
- you believe a migration, pet/size change, new dependency, or generalized custom-field framework is required.

## Return

Return complete file contents or a clean unified diff, plus:

1. findings;
2. exact files changed;
3. exact test commands and results;
4. anything not verified, especially authenticated browser QC;
5. resulting commit SHA if you committed, otherwise explicitly say no commit was created.
