# DeepSeek Engine 3 — platform resilience queue

## Supplied snapshot

This is a source subset from the Operro working tree on 9 October 2026 (Asia/Jakarta). Codex reviews/integrates every result. Do not deploy, modify production, create real accounts/invitations, modify provider configuration, open a PR, or claim an unrun test passed.

Read `START-HERE.md`, `operro/apps/web/AGENTS.md`, the parity audit, and supplied sources before each task. Produce one patch and handoff per task, then wait for `NEXT TASK`.

## Queue

### Task E3.1 — Backup export and restore verifier (#38)

Implement an owner-authorized bounded/asynchronous organization export producing versioned manifests, scoped table data, configuration, and a complete listing of organization Storage objects. Add a restore verifier/dry-run only: archive version, migrations, tenant IDs, row counts, hashes, and missing files. Do not mutate production, export Auth secrets/service keys/signed URLs/transient tokens, or call the result a backup unless a disposable-project restore is proven. Test isolation, interruptions, mismatched hashes, archived objects, unsupported data, and formula-safe tabular output.

### Task E3.2 — Access-policy regression suite (#41)

Add a permanent PostgreSQL 16 role/RLS regression suite proving: platform owner can enter suspended workspaces and inspect/change a tenant Admin checklist; tenant Admin cannot manage that checklist; and `Bantuan Operro` cannot access payroll, finance reporting, or access management. Do not create real invitations/accounts and do not rely on hidden UI for security. Keep current platform-owner superuser policy intact. Test cross-tenant and revoked/suspended states.

### Task E3.3 — Safe scheduled storage-cleanup foundation (#43)

Extend existing retention/cleanup patterns with a dry-run-first bounded job foundation, retry/idempotency, locking/concurrent-run safety, audit output, and metadata-before-object deletion checks. Never present a per-organization database-byte estimate or billing automation. Test active references, retention boundaries, missing Storage objects, partial failures, tenant isolation, retry behavior, and concurrency.

### Task E3.4 — Health and recovery readiness (#44)

Add a read-only owner/platform health surface using only safe existing signals: migration/app version, failed bounded maintenance jobs, pending capacity requests, and stale/error states. Add a recovery-readiness report/runbook with last verified restore-drill metadata and unresolved reconciliation counts, clearly linking to provider procedures without exposing provider credentials/logs or provider billing estimates. Test authorization, tenant redaction, stale/failure states, missing provider APIs, and a documented manual recovery exercise.

## Return format

For each task return: a compact finding table; one unified Git patch relative to `operro/`; and a handoff stating changes, migrations, raw checks/results, browser-tested/not-tested, tenant/security verification, limitations, and next task.
