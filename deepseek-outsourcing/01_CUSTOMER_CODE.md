# Assignment 01 — persistent customer code (#2)

Implement one feature: a stable, tenant-scoped customer code visible in the CRM and Customer 360.

Use the HomePaw file to determine the displayed format and behavior. Add a forward migration/backfill only if the existing schema has no authoritative field. Codes must be immutable after assignment, unique within an organization, safe under concurrent customer creation, and must not expose cross-tenant row counts. Existing customers need deterministic valid codes without changing customer IDs or financial history.

Add code search support using the existing customer search path and show the code on the customer list/detail. Include concurrency, tenant isolation, populated-upgrade, and search tests. Do not implement bulk editing or custom fields in this assignment.

