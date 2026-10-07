# Assignment 09 — dynamic bands in packages and payroll (#21, phase 3)

Prerequisite: Codex has integrated Assignments 07–08 and supplied a refreshed bundle.

Implement at most two integrations:

1. Package eligibility/reservations use stable tenant size-band IDs while preserving already-sold package terms and holds.
2. Payroll attribution/calculation uses snapshotted band information without rewriting published payroll or historical jobs.

Add guarded archive/delete behavior that refuses removal while an active service, package, pet/booking workflow, or unpublished payroll dependency still requires the band. Historical rows must remain readable after archival. Test existing memberships, held reservations, catalog changes, payroll publish locks, retry idempotency, and cross-tenant IDs.

