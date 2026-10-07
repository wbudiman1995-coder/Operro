# Assignment 16 — access regression and scheduled storage cleanup (#41, #43)

Implement at most two features:

1. A permanent PostgreSQL 16 role/RLS regression suite for the current access policy: platform owner can inspect/change a tenant Admin checklist and enter suspended workspaces; tenant Admin cannot manage the checklist; `Bantuan Operro` cannot access payroll, finance reporting, or access management.
2. A safe scheduled-cleanup job foundation that reuses existing retention rules, supports dry-run, bounded batches, retries/idempotency, audit output, and never deletes objects before authoritative metadata checks.

Do not create real accounts or invitations. Do not rely on hidden buttons for security. For cleanup, test active references, retention boundaries, missing Storage objects, partial failures, concurrent runs, and tenant isolation. Do not add billing automation in this assignment.

