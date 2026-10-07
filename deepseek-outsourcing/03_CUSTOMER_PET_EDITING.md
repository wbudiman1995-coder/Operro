# Assignment 03 — Customer 360 and pet editing (#3, #4)

Implement at most two features:

1. Safe editing of existing Customer 360 contact/address fields already accepted by customer creation.
2. Standalone edit/archive controls for an existing pet.

Reuse current validation, Indonesian address logic, breed selection, and weight-to-size rules. Archive rather than hard-delete a pet when historical bookings, invoices, evidence, or packages reference it. Edits must not rewrite snapshots on old bookings/invoices. Require server-side tenant/capability checks and optimistic concurrency or an equivalent stale-write guard.

Test cross-tenant access, archive refusal/behavior with live dependencies, historical snapshot preservation, invalid Maps/address input, and stale concurrent edits. Do not add coat profiles, wash counters, or generic custom fields.

