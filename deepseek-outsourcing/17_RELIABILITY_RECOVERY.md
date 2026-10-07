# Assignment 17 — monitoring and recovery readiness (#43, #44)

Implement at most two features:

1. An owner/platform read-only health surface using safe existing signals: migration/app version, failed bounded maintenance jobs, pending capacity requests, and stale/error states. Do not expose provider credentials or raw sensitive logs.
2. A recovery-readiness report/runbook with last verified backup/restore drill metadata, unresolved reconciliation counts, and explicit links/instructions for Supabase/Vercel provider usage; do not present estimates as provider billing.

If per-organization database-byte accounting is proposed, first document the exact PostgreSQL measurement limits and security design; do not ship a misleading number. Tests must cover authorization, stale status, failure states, tenant redaction, and absence of provider APIs. Include a manual disaster-recovery exercise rather than claiming recovery from UI compilation.

