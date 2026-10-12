# DeepSeek Engine 1 — owner experience queue

## Supplied snapshot

This packet is a source subset from the Operro working tree on 9 October 2026 (Asia/Jakarta). It is for review and patch production only. Codex is the reviewer/integrator. Do not deploy, modify production, open a PR, merge branches, create invitations, or claim tests that were not run.

Read `START-HERE.md`, `operro/apps/web/AGENTS.md`, the parity audit, and the applicable supplied source before each task. Return one unified patch and one handoff **per task**. Do not combine tasks in one patch and do not begin the next task until the user posts `NEXT TASK`.

## Queue

### Task E1.1 — Dashboard configuration (#1)

The current snapshot already has a tenant- and capability-scoped today-versus-yesterday dashboard comparison. Implement only per-business persisted card visibility, reusing the existing settings model. Do not invent acquisition ROI, a new analytics database, or browser-only preferences. Server-resolve the organization and require the appropriate owner capability for writes. Test tenant isolation, denied writes, empty data, invalid card keys, default fallback, and Jakarta date boundaries.

### Task E1.2 — Customer 360 custom fields, bounded foundation and display (#3, #40)

Customer and pet editing already exists. Add the smallest safe owner-configurable custom-field system required to display and edit values in Customer 360 and pet editing: short text, number, date, yes/no, and single select only. Use stable definition IDs, organization scope, entity scope, ordering, active/archive state, validated options, and RLS-safe values. Do not implement public onboarding, search, generic formulas, arbitrary JSON, or exports in this task. Test archived definitions, changed options, tenant isolation, invalid values, formula-like values, and old records without values.

### Task E1.3 — Pet coat profile and derived wash count (#4)

Add only the structured grooming/coat fields demonstrably used in the supplied HomePaw reference and a visit/job count derived from authoritative completed work. Never make it a manually drifting counter. Surface both in existing Customer 360/pet editing. Preserve bookings, invoices, evidence, snapshots, and archive semantics. Test completed versus cancelled work, archived pets, empty history, repeats, invalid values, and tenant isolation.

### Task E1.4 — Business settings and personal defaults (#39, #42)

Expose one existing authoritative organization setting that the reference actually uses, and add only one persisted per-user default (landing page or calendar view). Keep organization-owned settings separate from user-owned preferences. Validate allowed routes/views and fail safely after access revocation. Do not add language translation. Test user/tenant isolation, fallback behavior, malformed values, revoked access, and owner-only setting writes.

## Return format

For each task return: (1) a compact existing/HomePaw/change/risk table; (2) a unified Git patch relative to `operro/`; (3) a handoff with changed files, migration order, raw test output, browser-tested/not-tested, tenant/security checks, limitations, and next smallest task.
